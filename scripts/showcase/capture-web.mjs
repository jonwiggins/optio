/** Capture the real web UI. Run seed + playback in the private demo lab first. */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const m = JSON.parse(readFileSync("/tmp/optio-showcase-4965.json", "utf8"));
const out = "/tmp/optio-showcase-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function shot(name, path, ready, prepare) {
  await page.goto(`http://localhost:30311${path}`);
  await expect(page.getByText(ready, { exact: false }).first()).toBeVisible({ timeout: 15000 });
  if (prepare) await prepare();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  await expect(page).not.toHaveURL(/\/setup|\/login/);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name);
}
try {
  await shot("web-overview", "/", "Overview");
  await shot("web-work", "/work?view=recurring", "Keep dependencies current");
  await shot("web-agents", "/work?view=agents", "Engineering coordinator");
  await shot("web-history", "/work?view=history", "Add keyboard navigation");
  await shot("web-new-work", `/work/${m.examples.dependencies}/edit`, "Keep dependencies current");
  await shot("web-agent", `/agents/${m.agents.coordinator}`, "Engineering coordinator");
  await shot("web-task", `/tasks/${m.tasks.checkout}`, "Add keyboard navigation");
  await shot(
    "web-sessions",
    `/local/${m.live.claude}?split=${m.live.terminal}`,
    "Polish the checkout experience",
    async () => {
      await page.getByRole("radio", { name: "Chat", exact: true }).first().click();
    },
  );
  await shot("web-trigger", `/jobs/${m.examples.incident}`, "Investigate a production incident");
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  await browser.close();
}
