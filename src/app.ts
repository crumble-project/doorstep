import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { hashSecret, newSecret } from "./secrets";
import type { AccountStore, RelayEvent } from "./store";
import { ulid } from "./ulid";

export type Runtime = {
  adminTokenHash: string;
  account(accountId: string): AccountStore;
  delivered(accountId: string, event: RelayEvent): void;
  publicOrigin: string;
};

export const MAX_BODY_BYTES = 1024 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

const isHopByHop = (name: string) =>
  HOP_BY_HOP.has(name) || name.startsWith("proxy-");

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");

  return match?.[1];
}

export async function authenticateAccount(
  runtime: Pick<Runtime, "account">,
  header: string | undefined,
): Promise<{ accountId: string; store: AccountStore } | undefined> {
  const token = bearerToken(header);
  const accountId = token?.split(".", 1)[0];

  if (!token || !accountId || token.length === accountId.length)
    return undefined;
  const store = runtime.account(accountId);

  return (await store.verifyToken(await hashSecret(token)))
    ? { accountId, store }
    : undefined;
}

const unauthorized = (c: Context) => c.json({ error: "unauthorized" }, 401);

export function createApp(runtime: Runtime): Hono {
  const app = new Hono();

  app.post("/admin/accounts", async (c) => {
    const token = bearerToken(c.req.header("authorization"));

    if (!token || (await hashSecret(token)) !== runtime.adminTokenHash)
      return unauthorized(c);
    const accountId = ulid(new Date()).toLowerCase();
    const accountToken = `${accountId}.${newSecret()}`;
    await runtime.account(accountId).init(await hashSecret(accountToken));

    return c.json({ accountId, token: accountToken }, 201);
  });

  app.post("/v1/sources", async (c) => {
    const auth = await authenticateAccount(
      runtime,
      c.req.header("authorization"),
    );

    if (!auth) return unauthorized(c);
    const secret = newSecret();
    const source = await auth.store.addSource(await hashSecret(secret));

    return c.json(
      {
        id: source.id,
        url: `${runtime.publicOrigin}/h/${auth.accountId}/${secret}`,
      },
      201,
    );
  });

  app.get("/v1/sources", async (c) => {
    const auth = await authenticateAccount(
      runtime,
      c.req.header("authorization"),
    );

    if (!auth) return unauthorized(c);

    return c.json(await auth.store.listSources(), 200);
  });

  app.delete("/v1/sources/:id", async (c) => {
    const auth = await authenticateAccount(
      runtime,
      c.req.header("authorization"),
    );

    if (!auth) return unauthorized(c);

    if (!(await auth.store.removeSource(c.req.param("id"))))
      return c.json({ error: "not found" }, 404);

    return c.body(null, 204);
  });

  app.all(
    "/h/:accountId/:secret",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
    async (c) => {
      const accountId = c.req.param("accountId");
      const store = runtime.account(accountId);

      const source = await store.sourceBySecret(
        await hashSecret(c.req.param("secret")),
      );

      if (!source) return c.json({ error: "not found" }, 404);
      const body = new Uint8Array(await c.req.arrayBuffer());
      const headers: [string, string][] = [];
      c.req.raw.headers.forEach((value, name) => {
        if (!isHopByHop(name)) headers.push([name.toLowerCase(), value]);
      });

      const event = await store.enqueue(
        {
          sourceId: source.id,
          method: c.req.method,
          query: new URL(c.req.url).search.slice(1),
          headers,
          body: body.toBase64(),
        },
        new Date(),
      );

      if (event === "full") return c.json({ error: "queue full" }, 507);
      runtime.delivered(accountId, event);

      return c.body(null, 202);
    },
  );

  return app;
}
