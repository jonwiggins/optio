import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // *.int.test.ts files need real Postgres/Redis (vitest.integration.config.ts)
    // and e2e/ spawns real servers (vitest.e2e.config.ts) — never run here.
    exclude: [...configDefaults.exclude, "src/**/*.int.test.ts", "e2e/**"],
    coverage: {
      enabled: !!process.env.CI,
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
