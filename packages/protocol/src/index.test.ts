import { describe, expect, test } from "bun:test";
import { consumerMessage, relayMessage, type EventMessage } from "./index";

describe("protocol", () => {
  test("parses an event message", () => {
    const message = {
      type: "event",
      id: "01JBX0000000000000000000000",
      sourceId: "src_1",
      receivedAt: "2026-10-31T12:00:00.000Z",
      method: "POST",
      query: "a=1",
      headers: [["content-type", "application/json"]],
      body: "e30=",
    } satisfies EventMessage;

    const parsed = relayMessage.safeParse(message);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(message);
  });

  test("rejects an unknown type", () => {
    expect(consumerMessage.safeParse({ type: "nack" }).success).toBe(false);
  });
});
