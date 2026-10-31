import { afterAll } from "bun:test";
import { hashSecret } from "../secrets";
import { storeContract } from "../store-contract";
import { sqliteStores } from "./sqlite-store";

const stores = sqliteStores(":memory:");

afterAll(() => stores.close());

let next = 0;

storeContract("sqlite", async () => {
  const store = stores.account(`account-${next++}`);
  await store.init(await hashSecret("token"));

  return store;
});
