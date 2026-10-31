import { bearerToken, createApp } from "../app";
import { hashSecret } from "../secrets";
import { accountStore, type Env } from "./account";

export { Account } from "./account";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const account = (accountId: string) =>
      env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));

    if (new URL(request.url).pathname === "/v1/connect") {
      const accountId = bearerToken(
        request.headers.get("authorization") ?? undefined,
      )?.split(".", 1)[0];

      if (!accountId)
        return Response.json({ error: "unauthorized" }, { status: 401 });

      return account(accountId).fetch(request);
    }

    const app = createApp({
      adminTokenHash: await hashSecret(env.ADMIN_TOKEN),
      account: (accountId) => accountStore(account(accountId)),
      delivered: (accountId, event) =>
        ctx.waitUntil(account(accountId).deliver(event)),
      publicOrigin: env.PUBLIC_URL.replace(/\/+$/, ""),
    });

    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
