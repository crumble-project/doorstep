import type { EventMessage } from "@doorstep/protocol";

export type RelayEvent = Omit<EventMessage, "type">;

export type Source = { id: string; createdAt: string };

export interface AccountStore {
  init(tokenHash: string): Promise<void>;
  verifyToken(tokenHash: string): Promise<boolean>;
  addSource(secretHash: string): Promise<Source>;
  listSources(): Promise<Source[]>;
  removeSource(id: string): Promise<boolean>;
  sourceBySecret(secretHash: string): Promise<Source | undefined>;
  enqueue(
    event: Omit<RelayEvent, "id" | "receivedAt">,
    now: Date,
  ): Promise<RelayEvent | "full">;
  pending(): Promise<RelayEvent[]>;
  ack(id: string): Promise<boolean>;
  expire(now: Date): Promise<number>;
}

export const MAX_PENDING = 10_000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
