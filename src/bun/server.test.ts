import { afterAll, describe, expect, test } from "bun:test";
import {
  relayMessage,
  type Ack,
  type EventMessage,
  type Hello,
} from "@doorstep/protocol";
import { z } from "zod";
import { serve } from "./server";

const ADMIN_TOKEN = "admin-token";

const server = serve({
  port: 0,
  dataPath: ":memory:",
  adminToken: ADMIN_TOKEN,
  publicOrigin: "https://relay.example",
});

afterAll(() => server.stop());

type Consumer = {
  next(): Promise<Hello | EventMessage>;
  send(message: Ack): void;
  close(): Promise<void>;
};

const connect = (token: string): Promise<Consumer> =>
  new Promise((resolve, reject) => {
    const url = new URL("/v1/connect", server.url);
    url.protocol = "ws:";

    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    });

    const received: (Hello | EventMessage)[] = [];
    const waiting: ((message: Hello | EventMessage) => void)[] = [];
    socket.onmessage = (message) => {
      const parsed = relayMessage.parse(JSON.parse(String(message.data)));
      const waiter = waiting.shift();

      if (waiter) waiter(parsed);
      else received.push(parsed);
    };

    socket.onerror = () => reject(new Error("socket error"));
    socket.onopen = () =>
      resolve({
        next: () => {
          const message = received.shift();

          return message
            ? Promise.resolve(message)
            : new Promise((r) => waiting.push(r));
        },
        send: (message) => socket.send(JSON.stringify(message)),
        close: () =>
          new Promise((r) => {
            socket.onclose = () => r();
            socket.close();
          }),
      });
  });

const setup = async () => {
  const account = await fetch(new URL("/admin/accounts", server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });

  const { accountId, token } = z
    .object({ accountId: z.string(), token: z.string() })
    .parse(await account.json());

  const source = await fetch(new URL("/v1/sources", server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

  const { url } = z.object({ url: z.string() }).parse(await source.json());

  const hook = (body: string) =>
    fetch(new URL(new URL(url).pathname, server.url), {
      method: "POST",
      body,
    }).then((r) => r.status);

  return { accountId, token, hook };
};

const nextEvent = async (consumer: Consumer) => {
  const message = await consumer.next();

  if (message.type !== "event")
    throw new Error(`expected event, got ${message.type}`);

  return message;
};

describe("bun server", () => {
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
    await consumer.close();
  });

  test("an unacked event is sent again after reconnect, before newer events", async () => {
    const { token, hook } = await setup();
    const first = await connect(token);
    await first.next();
    await hook("old");
    const old = await nextEvent(first);
    await first.close();
    await hook("new");
    const second = await connect(token);
    await second.next();
    expect((await nextEvent(second)).id).toBe(old.id);
    expect(atob((await nextEvent(second)).body)).toBe("new");
    await second.close();
  });

  test("an acked event is not sent again", async () => {
    const { token, hook } = await setup();
    const first = await connect(token);
    await first.next();
    await hook("acked");
    const event = await nextEvent(first);
    first.send({ type: "ack", id: event.id });
    await Bun.sleep(50);
    await first.close();
    await hook("later");
    const second = await connect(token);
    await second.next();
    expect(atob((await nextEvent(second)).body)).toBe("later");
    await second.close();
  });

  test("two sockets both get a live event", async () => {
    const { token, hook } = await setup();
    const a = await connect(token);
    const b = await connect(token);
    await a.next();
    await b.next();
    await hook("both");
    const [fromA, fromB] = await Promise.all([nextEvent(a), nextEvent(b)]);
    expect(fromA.id).toBe(fromB.id);
    a.send({ type: "ack", id: fromA.id });
    b.send({ type: "ack", id: fromB.id });
    await Bun.sleep(50);
    await Promise.all([a.close(), b.close()]);
  });

  test("connect without a valid token is 401", async () => {
    const { accountId } = await setup();
    const url = new URL("/v1/connect", server.url);

    const headers = {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": btoa("0123456789abcdef"),
    };

    expect((await fetch(url, { headers })).status).toBe(401);

    const wrong = await fetch(url, {
      headers: { ...headers, authorization: `Bearer ${accountId}.nope` },
    });

    expect(wrong.status).toBe(401);
  });
});
