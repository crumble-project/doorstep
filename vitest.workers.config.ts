import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "admin-token",
          PUBLIC_URL: "https://relay.example",
        },
      },
    }),
  ],
  test: { include: ["src/worker/**/*.test.ts"] },
});
