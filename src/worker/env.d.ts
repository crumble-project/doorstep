import type { Account } from "./account";
import type * as Main from "./index";

declare global {
  namespace Cloudflare {
    interface Env {
      ACCOUNT: DurableObjectNamespace<Account>;
      ADMIN_TOKEN: string;
      PUBLIC_URL: string;
    }

    interface GlobalProps {
      mainModule: typeof Main;
      durableNamespaces: "Account";
    }
  }
}
