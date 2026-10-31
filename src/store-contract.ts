import { describe, expect, test } from "vitest";
import { hashSecret, newSecret } from "./secrets";
import { MAX_PENDING, RETENTION_MS, type AccountStore } from "./store";

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();

const event = (sourceId: string, body = "") => ({
  sourceId,
  method: "POST",
  query: "",
  headers: [["content-type", "application/json"]] satisfies [string, string][],
  body,
});

export function storeContract(
  name: string,
  make: () => Promise<AccountStore>,
): void {
  describe(`${name} store contract`, () => {
    test("acks delete an event", async () => {
      const store = await make();
      const queued = await store.enqueue(event("s"), new Date());

      if (queued === "full") throw new Error("unexpected full");
      expect(await store.ack(queued.id)).toBe(true);
      expect(await store.pending()).toEqual([]);
      expect(await store.ack(queued.id)).toBe(false);
    });

    test("pending is oldest first", async () => {
      const store = await make();
      const now = Date.now();
      const ids: string[] = [];

      for (let i = 0; i < 5; i++) {
        const queued = await store.enqueue(
          event("s", btoa(String(i))),
          new Date(now),
        );

        if (queued === "full") throw new Error("unexpected full");
        ids.push(queued.id);
      }

      expect((await store.pending()).map((e) => e.id)).toEqual(ids);
    });

    test('enqueue past MAX_PENDING returns "full"', async () => {
      const store = await make();
      const now = new Date();

      // Concurrent: 10k sequential Durable Object RPC round trips exceed the test timeout on CI.
      const filled = await Promise.all(
        Array.from({ length: MAX_PENDING }, () =>
          store.enqueue(event("s"), now),
        ),
      );

      expect(filled).not.toContain("full");
      expect(await store.enqueue(event("s"), now)).toBe("full");
    });

    test("expire drops events older than RETENTION_MS and keeps newer", async () => {
      const store = await make();
      const now = Date.now();
      await store.enqueue(event("s"), new Date(now - RETENTION_MS - 1));

      const fresh = await store.enqueue(
        event("s"),
        new Date(now - RETENTION_MS + 60_000),
      );

      if (fresh === "full") throw new Error("unexpected full");
      expect(await store.expire(new Date(now))).toBe(1);
      expect((await store.pending()).map((e) => e.id)).toEqual([fresh.id]);
    });

    test("a removed source is not found by its secret", async () => {
      const store = await make();
      const secretHash = await hashSecret(newSecret());
      const source = await store.addSource(secretHash);
      expect(await store.sourceBySecret(secretHash)).toEqual(source);
      expect(await store.listSources()).toEqual([source]);
      expect(await store.removeSource(source.id)).toBe(true);
      expect(await store.sourceBySecret(secretHash)).toBeUndefined();
      expect(await store.removeSource(source.id)).toBe(false);
    });

    test("body bytes survive a round trip", async () => {
      const store = await make();
      const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80, 0x0a]);
      await store.enqueue(event("s", bytes.toBase64()), new Date());
      const [stored] = await store.pending();
      expect(stored).toBeDefined();
      const roundTrip = Uint8Array.fromBase64(stored?.body ?? "");
      expect(await sha256(roundTrip)).toBe(await sha256(bytes));
    });
  });
}
