import { Database } from "bun:sqlite";
import {
  MAX_PENDING,
  RETENTION_MS,
  type AccountStore,
  type RelayEvent,
  type Source,
} from "../store";
import { ulid } from "../ulid";

type EventRow = {
  id: string;
  source_id: string;
  received_at: string;
  method: string;
  query: string;
  headers: string;
  body: Uint8Array;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sources_account ON sources (account_id);
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source_id TEXT NOT NULL,
    received_at TEXT NOT NULL, received_ms INTEGER NOT NULL,
    method TEXT NOT NULL, query TEXT NOT NULL, headers TEXT NOT NULL, body BLOB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_account ON events (account_id, id);
  CREATE INDEX IF NOT EXISTS events_received ON events (account_id, received_ms);
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

export type SqliteStores = {
  account: (accountId: string) => AccountStore;
  accountIds: () => string[];
  close: () => void;
};

export function sqliteStores(path: string): SqliteStores {
  const db = new Database(path, { strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(SCHEMA);

  const account = (accountId: string): AccountStore => ({
    async init(tokenHash) {
      db.query("INSERT INTO accounts (id, token_hash) VALUES (?, ?)").run(
        accountId,
        tokenHash,
      );
    },
    async verifyToken(tokenHash) {
      const row = db
        .query<{ token_hash: string }, [string]>(
          "SELECT token_hash FROM accounts WHERE id = ?",
        )
        .get(accountId);

      return row?.token_hash === tokenHash;
    },
    async addSource(secretHash) {
      const source: Source = {
        id: ulid(new Date()),
        createdAt: new Date().toISOString(),
      };

      db.query(
        "INSERT INTO sources (id, account_id, secret_hash, created_at) VALUES (?, ?, ?, ?)",
      ).run(source.id, accountId, secretHash, source.createdAt);

      return source;
    },
    async listSources() {
      return db
        .query<Source, [string]>(
          "SELECT id, created_at AS createdAt FROM sources WHERE account_id = ? ORDER BY id",
        )
        .all(accountId);
    },
    async removeSource(id) {
      return (
        db
          .query("DELETE FROM sources WHERE account_id = ? AND id = ?")
          .run(accountId, id).changes > 0
      );
    },
    async sourceBySecret(secretHash) {
      const row = db
        .query<Source, [string, string]>(
          "SELECT id, created_at AS createdAt FROM sources WHERE account_id = ? AND secret_hash = ?",
        )
        .get(accountId, secretHash);

      return row ?? undefined;
    },
    async enqueue(event, now) {
      const count = db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM events WHERE account_id = ?",
        )
        .get(accountId);

      if ((count?.n ?? 0) >= MAX_PENDING) return "full";

      const stored: RelayEvent = {
        ...event,
        id: ulid(now),
        receivedAt: now.toISOString(),
      };

      db.query(
        `INSERT INTO events (id, account_id, source_id, received_at, received_ms, method, query, headers, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        stored.id,
        accountId,
        stored.sourceId,
        stored.receivedAt,
        now.getTime(),
        stored.method,
        stored.query,
        JSON.stringify(stored.headers),
        Uint8Array.fromBase64(stored.body),
      );

      return stored;
    },
    async pending() {
      return db
        .query<EventRow, [string]>(
          "SELECT id, source_id, received_at, method, query, headers, body FROM events WHERE account_id = ? ORDER BY id",
        )
        .all(accountId)
        .map(toEvent);
    },
    async ack(id) {
      return (
        db
          .query("DELETE FROM events WHERE account_id = ? AND id = ?")
          .run(accountId, id).changes > 0
      );
    },
    async expire(now) {
      return db
        .query("DELETE FROM events WHERE account_id = ? AND received_ms < ?")
        .run(accountId, now.getTime() - RETENTION_MS).changes;
    },
  });

  const accountIds = () =>
    db
      .query<{ id: string }, []>("SELECT id FROM accounts")
      .all()
      .map((row) => row.id);

  return { account, accountIds, close: () => db.close() };
}
