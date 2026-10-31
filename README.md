# Doorstep

Self-hostable webhook relay: holds incoming webhooks at per-source addresses and forwards them to your server over its own outbound connection. No public address needed.

## How it works

1. You create a **source** and get an address: `https://<relay>/h/<accountId>/<sourceSecret>`. Give that address to a webhook provider such as GitHub.
2. When a webhook arrives, Doorstep stores it and answers `202 Accepted`. It does not parse, verify, or route by payload content: it keeps the method, query string, headers, and raw body byte for byte, so your server can verify provider signatures itself.
3. Your server opens a WebSocket to Doorstep (`GET /v1/connect`). Doorstep sends a `hello`, then every pending event oldest first, then new events as they arrive.
4. Your server answers each event with an `ack`. Doorstep deletes an event only after an `ack`, so delivery is at least once: an event sent before a dropped connection is sent again on the next connection. Deduplicate by event ID.

One account can have several sockets open; each gets every live event, and an `ack` from any of them deletes the event.

## API

All `/v1` requests use `Authorization: Bearer <accountToken>`. Admin requests use `Authorization: Bearer <adminToken>`. A missing or wrong token returns `401`.

| Request                     | Response                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `POST /admin/accounts`      | `201 { "accountId", "token" }`                                                     |
| `POST /v1/sources`          | `201 { "id", "url" }`. The URL contains the source secret and is shown only once.  |
| `GET /v1/sources`           | `200 [{ "id", "createdAt" }]`                                                      |
| `DELETE /v1/sources/:id`    | `204`, or `404`. The address stops working; its pending events stay deliverable.   |
| `ANY /h/:accountId/:secret` | `202`; `404` for an unknown source, `413` over 1 MiB, `507` when the queue is full |
| `GET /v1/connect`           | WebSocket upgrade                                                                  |

## Self-host with the binary

Build a single executable with Bun 1.4.4:

```sh
bun install
bun run build:binary
```

Run it:

```sh
DOORSTEP_ADMIN_TOKEN="$(openssl rand -base64 32)" \
DOORSTEP_PUBLIC_URL="https://relay.example.com" \
./dist/doorstep
```

| Variable               | Default             | Meaning                          |
| ---------------------- | ------------------- | -------------------------------- |
| `DOORSTEP_ADMIN_TOKEN` | required            | Token for `POST /admin/accounts` |
| `DOORSTEP_PUBLIC_URL`  | required            | Origin used in source URLs       |
| `DOORSTEP_PORT`        | `8787`              | HTTP port                        |
| `DOORSTEP_DATA`        | `./doorstep.sqlite` | SQLite database file             |

Put the relay behind a TLS-terminating reverse proxy that supports WebSockets. During development, `bun run start` runs the server from source.

## Deploy to Cloudflare

The Worker keeps one Durable Object per account, with SQLite storage and hibernating WebSockets.

1. Set `PUBLIC_URL` in `wrangler.jsonc` to the Worker's public origin.
2. Set the admin token as a secret:

   ```sh
   bunx wrangler secret put ADMIN_TOKEN
   ```

3. Deploy:

   ```sh
   bunx wrangler deploy
   ```

## Protocol

The message types are published as `@doorstep/protocol` (`packages/protocol`). Every message is a JSON text frame.

Relay to consumer:

```ts
type Hello = { type: "hello"; protocol: 1; accountId: string };
type EventMessage = {
  type: "event";
  id: string; // ULID, sortable by receipt
  sourceId: string;
  receivedAt: string; // ISO 8601
  method: string;
  query: string; // raw query string without "?"
  headers: [string, string][]; // names lowercased, hop-by-hop headers removed
  body: string; // base64 of the raw bytes
};
```

Consumer to relay:

```ts
type Ack = { type: "ack"; id: string };
```

A consumer should check `protocol` in `hello` before handling events.

## Limits

- Request body: at most 1 MiB.
- Pending events: at most 10,000 per account.
- Retention: unacknowledged events expire after 7 days and are never delivered after that.

## Security

- The relay stores payloads and can read them. Host your own if that matters to you.
- Source URLs are secrets: anyone with one can send events to your account. Delete a source to revoke its address.
- Doorstep stores only SHA-256 hashes of account tokens and source secrets.
- Doorstep does not verify provider signatures. Your server must verify them.

## Development

```sh
bun install
bun run check
```

`check` runs oxlint (with the vendored anti-slop plugin in `tools/oxlint/anti-slop`), the `bun fmt` format check, TypeScript, the Bun tests, and the Workers tests in `@cloudflare/vitest-plugin`.

| Command                | Does                                  |
| ---------------------- | ------------------------------------- |
| `bun run lint`         | `oxlint --deny-warnings`              |
| `bun run format`       | Formats the repository with `bun fmt` |
| `bun run format:check` | Fails if a file needs formatting      |
| `bun run fix`          | Formats, then applies oxlint fixes    |

## License

MIT
