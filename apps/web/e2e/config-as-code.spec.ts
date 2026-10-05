/**
 * Config as code in the UI: the e2e stack mounts a directory with one Prompt
 * manifest (launch-stack.ts), so Settings → Config as code shows the source
 * and its last sync, Sync now works, and the Prompts page marks the managed
 * row. The apply itself is covered by the API's integration and e2e tests.
 */
import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:4931";

interface Status {
  enabled: boolean;
  source: { path: string; lastSyncAt: string | null } | null;
}

async function syncedStatus(): Promise<Status> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await fetch(`${API}/api/config/status`);
    const status = (await res.json()) as Status;
    if (status.source?.lastSyncAt) return status;
    if (Date.now() > deadline) throw new Error("the configuration directory never synced");
    await new Promise((r) => setTimeout(r, 500));
  }
}

test.describe("Config as code", () => {
  test("Settings shows the directory, its last sync, and syncs on demand", async ({ page }) => {
    const status = await syncedStatus();
    expect(status.enabled).toBe(true);

    await page.goto("/settings");
    const card = page.locator("section", { hasText: "Config as code" }).first();
    await expect(page.getByText("Config as code", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(card.getByText(status.source!.path, { exact: true })).toBeVisible();
    // The summary line and the result tags both say it; one is enough.
    await expect(card.getByText(/^\d+ unchanged$|^\d+ created$/).first()).toBeVisible();

    await card.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText(/^Synced/)).toBeVisible({ timeout: 30_000 });
  });

  test("Prompts marks the managed row", async ({ page }) => {
    await syncedStatus();
    await page.goto("/templates");
    await expect(page.getByText("E2E managed prompt", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const row = page
      .locator("li, tr, div", { hasText: "E2E managed prompt" })
      .filter({ hasText: "Managed" })
      .first();
    await expect(row).toBeVisible();
    // The seeded, hand-made prompt carries no Managed chip.
    const seeded = page.getByText("E2E seed prompt", { exact: true });
    await expect(seeded).toBeVisible();
  });
});
