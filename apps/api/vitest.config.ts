import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: !!process.env.CI,
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/db/migrations/**", "src/index.ts"],
      thresholds: {
        lines: 25,
        branches: 50,
        functions: 25,
        statements: 25,
      },
    },
  },
});
