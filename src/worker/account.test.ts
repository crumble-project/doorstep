import { env, exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  relayMessage,
  type EventMessage,
  type Hello,
} from "@doorstep/protocol";
import { hashSecret } from "../secrets";
import { storeContract } from "../store-contract";
import { accountStore } from "./account";

const ADMIN_TOKEN = "admin-token";

storeContract("durable object", async () => {
  const store = accountStore(
    env.ACCOUNT.get(env.ACCOUNT.idFromName(crypto.randomUUID())),
  );

  await store.init(await hashSecret("token"));

  return store;
});

type Consumer = { next(): Promise<Hello | EventMessage>; close(): void };

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://relay.example${path}`, init));

const connect = async (token: string): Promise<Consumer> => {
  const response = await request("/v1/connect", {
    headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
  });

  const socket = response.webSocket;

  if (!socket) throw new Error(`expected a WebSocket, got ${response.status}`);
  const received: (Hello | EventMessage)[] = [];
  const waiting: ((message: Hello | EventMessage) => void)[] = [];
  socket.addEventListener("message", (message: MessageEvent) => {
    const parsed = relayMessage.parse(JSON.parse(String(message.data)));
    const waiter = waiting.shift();

    if (waiter) waiter(parsed);
    else received.push(parsed);
  });
  socket.accept();

  return {
    next: () => {
      const message = received.shift();

      return message
        ? Promise.resolve(message)
        : new Promise((resolve) => waiting.push(resolve));
    },
    close: () => socket.close(1000, "done"),
  };
};

const setup = async () => {
  const account = await request("/admin/accounts", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });

  expect(account.status).toBe(201);

  const { accountId, token } = await account.json<{
    accountId: string;
    token: string;
  }>();

  const source = await request("/v1/sources", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

  const { url } = await source.json<{ url: string }>();

  const hook = async (body: string) =>
    (await request(new URL(url).pathname, { method: "POST", body })).status;

  return { accountId, token, hook };
};

const nextEvent = async (consumer: Consumer) => {
  const message = await consumer.next();

  if (message.type !== "event")
    throw new Error(`expected event, got ${message.type}`);

  return message;
};

describe("worker", () => {
  test("a connected consumer gets hello then the event", async () => {
    const { accountId, token, hook } = await setup();
    expect(await hook("before")).toBe(202);
    const consumer = await connect(token);
    expect(await consumer.next()).toEqual({
      type: "hello",
      protocol: 1,
      accountId,
    });
    expect(atob((await nextEvent(consumer)).body)).toBe("before");
    expect(await hook("live")).toBe(202);
    expect(atob((await nextEvent(consumer)).body)).toBe("live");
    consumer.close();
  });

  test("an unacked event is sent again after reconnect", async () => {
    const { token, hook } = await setup();
    const first = await connect(token);
    await first.next();
    await hook("old");
    const old = await nextEvent(first);
    first.close();
    await hook("new");
    const second = await connect(token);
    await second.next();
    expect((await nextEvent(second)).id).toBe(old.id);
    expect(atob((await nextEvent(second)).body)).toBe("new");
    second.close();
  });
});
