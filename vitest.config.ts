import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB", "IMPORT_DB"],
        bindings: {
          ENVIRONMENT: "local",
          DEV_AUTH: "true",
          ADMIN_ORIGIN: "http://127.0.0.1:8787",
          BROKER_HOSTNAME: "127.0.0.1",
          OWNER_EMAILS: "local@example.test",
          INSTANCE_EPOCH: "test-epoch",
          APP_SIGNING_SECRET: "test-only-signing-secret-at-least-32-bytes",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
