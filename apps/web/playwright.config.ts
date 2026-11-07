import { defineConfig, devices } from "@playwright/test";
import { WEB } from "./e2e/stack-ports";

/**
 * Browser e2e for the Optio web UI against the full deterministic stack:
 * real API (fake container runtime — no cluster, no LLM calls) + the web app
 * (a production build when CI is set, else next dev; see e2e/launch-stack.ts).
 * e2e/launch-stack.ts owns infra startup and data seeding.
 *
 * Run with:  pnpm --filter @optio/web test:e2e
 * First time: npx playwright install chromium firefox
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
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      testMatch: "**/optio-assistant.spec.ts",
      // Firefox covers what differs by browser (dictation, docking, narrow layouts); @form-logic
      // tests exercise plain forms and state, so Chromium alone runs them.
      grepInvert: /@form-logic/,
      use: { ...devices["Desktop Firefox"] },
    },
  ],
  webServer: {
    command: "npx tsx e2e/launch-stack.ts",
    url: WEB,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
    // SIGTERM, not the default SIGKILL: launch-stack.ts must stop the API,
    // which runs in its own process group, or it outlives the run on the API port.
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
  },
});
