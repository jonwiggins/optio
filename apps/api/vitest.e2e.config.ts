import { defineConfig } from "vitest/config";

/**
 * E2E tier: e2e/*.e2e.test.ts files spawn the REAL API server (tsx
 * src/index.ts) against a private Postgres/Redis per test file, with the
 * container runtime faked (OPTIO_RUNTIME=fake) so agent runs are
 * deterministic and free. Exercises the full pipeline: HTTP API → BullMQ →
 * workers → fake pods → log streaming → reconciler → terminal states.
 *
 * Run with:  pnpm --filter @optio/api test:e2e
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    globalSetup: ["./src/test-utils/integration/global-setup.ts"],
    setupFiles: ["./src/test-utils/e2e/setup.ts"],
    pool: "forks",
    // Every file boots a full API server (tsx + 14 workers); unbounded
    // parallelism starves them on 4-vCPU CI runners and flakes provisioning.
    maxWorkers: 2,
    testTimeout: 120_000,
    hookTimeout: 150_000,
    teardownTimeout: 20_000,
  },
});
