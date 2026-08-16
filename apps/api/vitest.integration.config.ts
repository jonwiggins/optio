import { defineConfig } from "vitest/config";

/**
 * Integration tier: *.int.test.ts files run against a real Postgres (cloned
 * per file from a migrated template DB) and a real Redis. See
 * src/test-utils/integration/global-setup.ts for infra provisioning and
 * src/test-utils/integration/setup.ts for the per-file isolation model.
 *
 * Run with:  pnpm --filter @optio/api test:integration
 */
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    globalSetup: ["./src/test-utils/integration/global-setup.ts"],
    setupFiles: ["./src/test-utils/integration/setup.ts"],
    // Forks give each test file its own process, so the module-level
    // singletons (db pool, redis url) bind to that file's private database.
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Workers keep BullMQ/redis handles alive; don't let a leaked handle
    // hang the run forever.
    teardownTimeout: 15_000,
  },
});
