import { DurableObject } from "cloudflare:workers";
import {
  consumerMessage,
  PROTOCOL_VERSION,
  type EventMessage,
  type Hello,
} from "@doorstep/protocol";
import { bearerToken } from "../app";
import { hashSecret } from "../secrets";
import {
  MAX_PENDING,
  RETENTION_MS,
  type AccountStore,
  type RelayEvent,
  type Source,
} from "../store";
import { ulid } from "../ulid";

export type Env = Cloudflare.Env;

type EventRow = {
  id: string;
  source_id: string;
  received_at: string;
  method: string;
  query: string;
  headers: string;
  body: ArrayBuffer;
};

const HOUR_MS = 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS account (key INTEGER PRIMARY KEY CHECK (key = 1), token_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, received_at TEXT NOT NULL, received_ms INTEGER NOT NULL,
    method TEXT NOT NULL, query TEXT NOT NULL, headers TEXT NOT NULL, body BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_received ON events (received_ms);
`;

const toEvent = (row: EventRow): RelayEvent => ({
  id: row.id,
  sourceId: row.source_id,
  receivedAt: row.received_at,
  method: row.method,
  query: row.query,
  headers: JSON.parse(row.headers),
  body: new Uint8Array(row.body).toBase64(),
});

type WireEvent = Omit<RelayEvent, "headers"> & { headers: string[][] };

// RPC stub types widen tuples (event headers) to string[][]; restore the pairs.
const fromWire = ({ headers, ...event }: WireEvent): RelayEvent => ({
  ...event,
  headers: headers.map(([name = "", value = ""]): [string, string] => [
    name,
    value,
  ]),
});

export const accountStore = (
  stub: DurableObjectStub<Account>,
): AccountStore => ({
  init: (tokenHash) => stub.init(tokenHash),
  verifyToken: (tokenHash) => stub.verifyToken(tokenHash),
  addSource: (secretHash) => stub.addSource(secretHash),
  listSources: () => stub.listSources(),
  removeSource: (id) => stub.removeSource(id),
  sourceBySecret: (secretHash) => stub.sourceBySecret(secretHash),
  enqueue: async (event, now) => {
    const stored = await stub.enqueue(event, now);

    return stored === "full" ? stored : fromWire(stored);
  },
  pending: async () => (await stub.pending()).map(fromWire),
  ack: (id) => stub.ack(id),
  expire: (now) => stub.expire(now),
});

const send = (socket: WebSocket, message: Hello | EventMessage) =>
  socket.send(JSON.stringify(message));

export class Account extends DurableObject<Env> implements AccountStore {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  async init(tokenHash: string): Promise<void> {
    this.sql.exec(
      "INSERT INTO account (key, token_hash) VALUES (1, ?)",
      tokenHash,
    );
    await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
  }

  async verifyToken(tokenHash: string): Promise<boolean> {
    return this.tokenMatches(tokenHash);
  }

  async addSource(secretHash: string): Promise<Source> {
    const source: Source = {
      id: ulid(new Date()),
      createdAt: new Date().toISOString(),
    };

    this.sql.exec(
      "INSERT INTO sources (id, secret_hash, created_at) VALUES (?, ?, ?)",
      source.id,
      secretHash,
      source.createdAt,
    );

    return source;
  }

  async listSources(): Promise<Source[]> {
    return this.sql
      .exec<Source>(
        "SELECT id, created_at AS createdAt FROM sources ORDER BY id",
      )
      .toArray();
  }

  async removeSource(id: string): Promise<boolean> {
    return (
      this.sql
        .exec("DELETE FROM sources WHERE id = ? RETURNING id", id)
        .toArray().length > 0
    );
  }

  async sourceBySecret(secretHash: string): Promise<Source | undefined> {
    return this.sql
      .exec<Source>(
        "SELECT id, created_at AS createdAt FROM sources WHERE secret_hash = ?",
        secretHash,
      )
      .toArray()[0];
  }

  async enqueue(
    event: Omit<RelayEvent, "id" | "receivedAt">,
    now: Date,
  ): Promise<RelayEvent | "full"> {
    if (
      this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM events").one()
        .n >= MAX_PENDING
    )
      return "full";

    const stored: RelayEvent = {
      ...event,
      id: ulid(now),
      receivedAt: now.toISOString(),
    };

    this.sql.exec(
      `INSERT INTO events (id, source_id, received_at, received_ms, method, query, headers, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      stored.id,
      stored.sourceId,
      stored.receivedAt,
      now.getTime(),
      stored.method,
      stored.query,
      JSON.stringify(stored.headers),
      Uint8Array.fromBase64(stored.body).buffer,
    );

    return stored;
  }

  async pending(): Promise<RelayEvent[]> {
    return this.pendingEvents();
  }

  async ack(id: string): Promise<boolean> {
    return (
      this.sql
        .exec("DELETE FROM events WHERE id = ? RETURNING id", id)
        .toArray().length > 0
    );
  }

  async expire(now: Date): Promise<number> {
    return this.expireBefore(now);
  }

  async deliver(event: RelayEvent): Promise<void> {
    for (const socket of this.ctx.getWebSockets())
      send(socket, { type: "event", ...event });
  }

  override async fetch(request: Request): Promise<Response> {
    const token = bearerToken(
      request.headers.get("authorization") ?? undefined,
    );

    if (!token || !this.tokenMatches(await hashSecret(token))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(
        { error: "expected a WebSocket upgrade" },
        { status: 426 },
      );
    }

    const accountId = token.split(".", 1)[0] ?? "";
    const { 0: client, 1: server } = new WebSocketPair();
    // From accept to the last backlog send nothing awaits, so no live delivery can slip in between.
    this.ctx.acceptWebSocket(server);
    send(server, { type: "hello", protocol: PROTOCOL_VERSION, accountId });
    this.expireBefore(new Date());

    for (const event of this.pendingEvents())
      send(server, { type: "event", ...event });

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    _socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    let json: unknown;

    try {
      json = JSON.parse(await new Response(message).text());
    } catch {
      return;
    }

    const parsed = consumerMessage.safeParse(json);

    if (parsed.success) await this.ack(parsed.data.id);
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      socket.close();
    }
  }

  override async alarm(): Promise<void> {
    this.expireBefore(new Date());
    await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
  }

  private tokenMatches(tokenHash: string): boolean {
    const row = this.sql
      .exec<{ token_hash: string }>(
        "SELECT token_hash FROM account WHERE key = 1",
      )
      .toArray()[0];

    return row?.token_hash === tokenHash;
  }

  private pendingEvents(): RelayEvent[] {
    return this.sql
      .exec<EventRow>(
        "SELECT id, source_id, received_at, method, query, headers, body FROM events ORDER BY id",
      )
      .toArray()
      .map(toEvent);
  }

  private expireBefore(now: Date): number {
    return this.sql
      .exec(
        "DELETE FROM events WHERE received_ms < ? RETURNING id",
        now.getTime() - RETENTION_MS,
      )
      .toArray().length;
  }
}
