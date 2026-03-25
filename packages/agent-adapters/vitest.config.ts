import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: !!process.env.CI,
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.spec.ts", "src/index.ts"],
      thresholds: {
        lines: 50,
        branches: 80,
        functions: 80,
        statements: 50,
      },
    },
  },
});
