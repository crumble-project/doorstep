import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const hello = z.object({
  type: z.literal("hello"),
  protocol: z.literal(PROTOCOL_VERSION),
  accountId: z.string(),
});

const event = z.object({
  type: z.literal("event"),
  id: z.string(),
  sourceId: z.string(),
  receivedAt: z.string(),
  method: z.string(),
  query: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.string(),
});

const ack = z.object({
  type: z.literal("ack"),
  id: z.string(),
});

export type Hello = z.infer<typeof hello>;

export type EventMessage = z.infer<typeof event>;

export type Ack = z.infer<typeof ack>;

export const relayMessage: z.ZodType<Hello | EventMessage> =
  z.discriminatedUnion("type", [hello, event]);

export const consumerMessage: z.ZodType<Ack> = z.discriminatedUnion("type", [
  ack,
]);
