import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        // The test Worker exports a Keeper built around the tests' config.
        // Workers AI and Vectorize are never called: tests pass fakes (test/fakes.js).
        main: "./test/worker.js",
        wrangler: { configPath: "./test/wrangler.test.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: "test-admin-token-0123456789",
            SESSION_SECRET: "test-session-secret-0123456789",
            IP_SALT: "test-ip-salt-0123456789",
            TURNSTILE_SECRET: "test-turnstile-secret",
            SITE_PROOF: "proof-0123456789abcdef",
            GITHUB_WEBHOOK_SECRET: "gh-webhook-secret-0123456789",
            ALLOWED_ORIGINS: "https://docs.example.com, https://www.example.com",
            PUBLIC_URL: "https://ask.test",
            FORWARD_TO: "owner@example.com",
            MAIL_FROM: "Ask <ask@example.com>",
            INBOX_SIGNATURE: "— The Example team",
            // Tests drive Keeper runs directly with chosen times.
            PAUSE_ALARMS: "1",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.js"],
      include: ["test/**/*.test.js"],
      testTimeout: 30_000,
    },
  };
});
