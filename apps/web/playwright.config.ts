import { defineConfig, devices } from "@playwright/test";

/**
 * Browser e2e for the Optio web UI against the full deterministic stack:
 * real API (fake container runtime — no cluster, no LLM calls) + next dev.
 * e2e/launch-stack.ts owns infra startup and data seeding.
 *
 * Run with:  pnpm --filter @optio/web test:e2e
 * First time: npx playwright install chromium
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3131",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx tsx e2e/launch-stack.ts",
    url: "http://127.0.0.1:3131",
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  },
});
