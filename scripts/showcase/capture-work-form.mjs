/** Capture the real creation form with When and Environment visible. Never submits. */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium, expect } = require("@playwright/test");
const out = "/tmp/optio-showcase-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1600 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://localhost:30311/work/new");
  await expect(page.getByRole("heading", { name: "New work", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Environment/ }).click();
  await expect(page.getByText("Storefront GitHub", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Accessibility review/ })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Setup commands", exact: true })
    .fill("pnpm install --frozen-lockfile");
  await page
    .getByPlaceholder(
      "Describe the change. Be specific about files to modify and expected behavior.",
    )
    .fill(
      "Improve keyboard navigation in checkout. Follow the repository conventions, review accessibility, and run the relevant tests. Open a draft pull request with a clear summary.",
    );
  await page
    .getByRole("textbox", { name: "Work name", exact: true })
    .fill("Make checkout work for everyone");
  await page.getByRole("button", { name: "Draft — a person merges", exact: true }).click();
  await page.getByRole("button", { name: "Review once CI passes", exact: true }).click();
  await page.evaluate(() => {
    document.querySelectorAll("*").forEach((element) => {
      if (element.scrollTop) element.scrollTo(0, 0);
    });
    window.scrollTo(0, 0);
  });
  // Frame both complete sections in a real viewport, keeping the summary visible.
  const where = await page.locator("#session-where").boundingBox();
  await page.setViewportSize({ width: 1440, height: Math.ceil(where.y + where.height + 18) });
  await page.evaluate(() => {
    document.querySelector("main")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await expect(page.getByRole("textbox", { name: "Setup commands", exact: true })).toBeVisible();
  await page.screenshot({ path: `${out}/web-create-work.png` });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Captured work creation with triggers and environment settings.");
} finally {
  await browser.close();
}
