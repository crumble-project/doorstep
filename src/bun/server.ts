import type { ServerWebSocket } from "bun";
import {
  consumerMessage,
  PROTOCOL_VERSION,
  type EventMessage,
  type Hello,
} from "@doorstep/protocol";
import { authenticateAccount, createApp, type Runtime } from "../app";
import type { AccountStore, RelayEvent } from "../store";
import { sqliteStores } from "./sqlite-store";

type Connection = {
  accountId: string;
  store: AccountStore;
  // Live events that arrive while the backlog is being sent; null once it has been flushed.
  held: RelayEvent[] | null;
};

const HOUR_MS = 60 * 60 * 1000;

const send = (
  socket: ServerWebSocket<Connection>,
  message: Hello | EventMessage,
) => socket.send(JSON.stringify(message));

const sendEvent = (socket: ServerWebSocket<Connection>, event: RelayEvent) =>
  send(socket, { type: "event", ...event });

export type DoorstepServer = { url: URL; stop: () => Promise<void> };

export function serve(options: {
  port: number;
  dataPath: string;
  adminToken: string;
  publicOrigin: string;
}): DoorstepServer {
  const stores = sqliteStores(options.dataPath);
  const sockets = new Map<string, Set<ServerWebSocket<Connection>>>();

  const runtime: Runtime = {
    adminTokenHash: new Bun.CryptoHasher("sha256")
      .update(options.adminToken)
      .digest("hex"),
    account: (accountId) => stores.account(accountId),
    delivered(accountId, event) {
      for (const socket of sockets.get(accountId) ?? []) {
        if (socket.data.held) socket.data.held.push(event);
        else sendEvent(socket, event);
      }
    },
    publicOrigin: options.publicOrigin.replace(/\/+$/, ""),
  };

  const app = createApp(runtime);

  const expireAll = async () => {
    const now = new Date();

    for (const accountId of stores.accountIds())
      await stores.account(accountId).expire(now);
  };

  const timer = setInterval(expireAll, HOUR_MS);

  const server = Bun.serve<Connection>({
    port: options.port,
    async fetch(request, server) {
      if (new URL(request.url).pathname !== "/v1/connect")
        return app.fetch(request);

      const auth = await authenticateAccount(
        runtime,
        request.headers.get("authorization") ?? undefined,
      );

      if (!auth)
        return Response.json({ error: "unauthorized" }, { status: 401 });

      if (server.upgrade(request, { data: { ...auth, held: [] } }))
        return undefined;

      return Response.json(
        { error: "expected a WebSocket upgrade" },
        { status: 426 },
      );
    },
    websocket: {
      async open(socket) {
        const { accountId, store } = socket.data;
        let set = sockets.get(accountId);

        if (!set) sockets.set(accountId, (set = new Set()));
        set.add(socket);
        send(socket, { type: "hello", protocol: PROTOCOL_VERSION, accountId });
        await store.expire(new Date());
        const backlog = await store.pending();

        for (const event of backlog) sendEvent(socket, event);
        const sent = new Set(backlog.map((event) => event.id));

        for (const event of socket.data.held ?? [])
          if (!sent.has(event.id)) sendEvent(socket, event);
        socket.data.held = null;
      },
      async message(socket, raw) {
        let json: unknown;

        try {
          json = JSON.parse(String(raw));
        } catch {
          return;
        }

        const parsed = consumerMessage.safeParse(json);

        if (parsed.success) await socket.data.store.ack(parsed.data.id);
      },
      close(socket) {
        const set = sockets.get(socket.data.accountId);
        set?.delete(socket);

        if (set?.size === 0) sockets.delete(socket.data.accountId);
      },
    },
  });

  return {
    url: server.url,
    async stop() {
      clearInterval(timer);
      await server.stop(true);
      stores.close();
    },
  };
}

if (import.meta.main) {
  const adminToken = process.env.DOORSTEP_ADMIN_TOKEN;
  const publicOrigin = process.env.DOORSTEP_PUBLIC_URL;

  if (!adminToken || !publicOrigin) {
    console.error("DOORSTEP_ADMIN_TOKEN and DOORSTEP_PUBLIC_URL are required");
    process.exit(1);
  }

  const { url } = serve({
    port: Number(process.env.DOORSTEP_PORT ?? 8787),
    dataPath: process.env.DOORSTEP_DATA ?? "./doorstep.sqlite",
    adminToken,
    publicOrigin,
  });

  console.log(`doorstep listening on ${url.href}`);
}
