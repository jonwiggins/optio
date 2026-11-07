import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // *.int.test.ts files need real Postgres/Redis (vitest.integration.config.ts)
    // and e2e/ spawns real servers (vitest.e2e.config.ts) — never run here.
    exclude: [...configDefaults.exclude, "**/dist/**", "src/**/*.int.test.ts", "e2e/**"],
    // A test's first `await import()` of a service transforms that service's whole import
    // graph, and a few tests run `helm template`; on a busy machine or a 4-vCPU CI runner
    // either has taken more than the 5 s default, failing tests that assert nothing about
    // speed (four of them in one run, 2026-11-06).
    testTimeout: 20_000,
    coverage: {
      // The aggregate unit + integration command enforces these thresholds.
      // Unit tests alone deliberately mock services covered by the database tier.
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/db/migrations/**",
        "src/index.ts",
        // Test infrastructure (integration/e2e harnesses) — exercised only by
        // the non-coverage tiers; including it would dilute unit coverage.
        "src/test-utils/**",
      ],
      thresholds: {
        lines: 50,
        branches: 65,
        functions: 50,
        statements: 50,
      },
    },
  },
});
