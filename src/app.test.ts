import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { createApp } from "./app";
import { hashSecret } from "./secrets";
import type { RelayEvent } from "./store";
import { sqliteStores } from "./bun/sqlite-store";

const ADMIN_TOKEN = "admin-token";
const stores = sqliteStores(":memory:");

afterAll(() => stores.close());

const delivered: { accountId: string; event: RelayEvent }[] = [];

const app = createApp({
  adminTokenHash: await hashSecret(ADMIN_TOKEN),
  account: (accountId) => stores.account(accountId),
  delivered: (accountId, event) => delivered.push({ accountId, event }),
  publicOrigin: "https://relay.example",
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const createAccount = async () => {
  const response = await app.request("/admin/accounts", {
    method: "POST",
    headers: bearer(ADMIN_TOKEN),
  });

  expect(response.status).toBe(201);

  return z
    .object({ accountId: z.string(), token: z.string() })
    .parse(await response.json());
};

const createSource = async (token: string) => {
  const response = await app.request("/v1/sources", {
    method: "POST",
    headers: bearer(token),
  });

  expect(response.status).toBe(201);

  return z
    .object({ id: z.string(), url: z.string() })
    .parse(await response.json());
};

const path = (url: string) => new URL(url).pathname;

describe("app", () => {
  test("admin creates an account", async () => {
    const { accountId, token } = await createAccount();
    expect(token.startsWith(`${accountId}.`)).toBe(true);

    const sources = await app.request("/v1/sources", {
      headers: bearer(token),
    });

    expect(sources.status).toBe(200);
    expect(await sources.json()).toEqual([]);
  });

  test("wrong admin token is 401", async () => {
    const wrong = await app.request("/admin/accounts", {
      method: "POST",
      headers: bearer("nope"),
    });

    expect(wrong.status).toBe(401);
    const missing = await app.request("/admin/accounts", { method: "POST" });
    expect(missing.status).toBe(401);
    const { accountId } = await createAccount();

    const wrongAccount = await app.request("/v1/sources", {
      headers: bearer(`${accountId}.nope`),
    });

    expect(wrongAccount.status).toBe(401);
  });

  test("source URL accepts a webhook and the event is delivered", async () => {
    const { accountId, token } = await createAccount();
    const source = await createSource(token);
    expect(source.url.startsWith(`https://relay.example/h/${accountId}/`)).toBe(
      true,
    );

    const response = await app.request(`${path(source.url)}?a=1&b=2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"hello":"world"}\n',
    });

    expect(response.status).toBe(202);
    const last = delivered.at(-1);
    expect(last?.accountId).toBe(accountId);
    expect(last?.event.sourceId).toBe(source.id);
    expect(last?.event.method).toBe("POST");
    expect(last?.event.query).toBe("a=1&b=2");
    expect(atob(last?.event.body ?? "")).toBe('{"hello":"world"}\n');
    expect(
      (await stores.account(accountId).pending()).map((e) => e.id),
    ).toEqual([last?.event.id ?? ""]);
  });

  test("body over 1 MiB is 413", async () => {
    const { token } = await createAccount();
    const source = await createSource(token);

    const response = await app.request(path(source.url), {
      method: "POST",
      body: new Uint8Array(1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);

    const exact = await app.request(path(source.url), {
      method: "POST",
      body: new Uint8Array(1024 * 1024),
    });

    expect(exact.status).toBe(202);
  });

  test("deleted source is 404", async () => {
    const { accountId, token } = await createAccount();
    const source = await createSource(token);
    expect(
      (await app.request(path(source.url), { method: "POST", body: "x" }))
        .status,
    ).toBe(202);

    const removed = await app.request(`/v1/sources/${source.id}`, {
      method: "DELETE",
      headers: bearer(token),
    });

    expect(removed.status).toBe(204);

    const again = await app.request(`/v1/sources/${source.id}`, {
      method: "DELETE",
      headers: bearer(token),
    });

    expect(again.status).toBe(404);
    expect(
      (await app.request(path(source.url), { method: "POST", body: "x" }))
        .status,
    ).toBe(404);
    expect(await stores.account(accountId).pending()).toHaveLength(1);
    const listed = await app.request("/v1/sources", { headers: bearer(token) });
    expect(await listed.json()).toEqual([]);
  });

  test("hop-by-hop headers are dropped and others are kept lowercased", async () => {
    const { token } = await createAccount();
    const source = await createSource(token);

    const response = await app.request(path(source.url), {
      method: "POST",
      headers: {
        "X-GitHub-Event": "push",
        "X-Hub-Signature-256": "sha256=abc",
        Connection: "keep-alive",
        "Keep-Alive": "timeout=5",
        Upgrade: "h2c",
        "Proxy-Authorization": "Basic x",
        TE: "trailers",
        Trailer: "Expires",
      },
      body: "x",
    });

    expect(response.status).toBe(202);
    const names = (delivered.at(-1)?.event.headers ?? []).map(([name]) => name);
    expect(names).toContain("x-github-event");
    expect(names).toContain("x-hub-signature-256");

    for (const dropped of [
      "connection",
      "keep-alive",
      "upgrade",
      "proxy-authorization",
      "te",
      "trailer",
    ]) {
      expect(names).not.toContain(dropped);
    }
  });
});
