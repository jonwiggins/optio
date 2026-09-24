/**
 * The Machines page against the seeded stack: "Add machine" walks through
 * pairing with this server's own commands, and the seeded laptop — offline,
 * since no daemon runs here — says what to run instead of offering to
 * change its directories.
 */
import { expect, test } from "@playwright/test";

test("Add machine shows this server's pairing commands", async ({ page }) => {
  await page.goto("/machines");
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "E2E laptop" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(main.getByText(/E2E laptop is offline — start optio local up on it/)).toBeVisible();
  await expect(main.getByRole("button", { name: /Remove/ })).toHaveCount(0);

  await main.getByRole("button", { name: "Add machine" }).click();
  await expect(main.getByRole("heading", { name: "Pair another machine" })).toBeVisible();
  // Auth is off in this stack: no sign-in step, and the daemon names the server.
  await expect(main.getByText("optio --server http://127.0.0.1:4931 local up")).toBeVisible();
  await expect(main.getByText(/optio login/)).toHaveCount(0);
  await expect(main.getByText("Waiting for a machine to connect…")).toBeVisible();

  await main.getByRole("button", { name: "Close" }).click();
  await expect(main.getByRole("heading", { name: "Pair another machine" })).toHaveCount(0);
});

test("the New work form offers no directory it can't add on an offline machine", async ({
  page,
}) => {
  await page.goto("/work/new");
  await expect(page.getByRole("heading", { name: "New work" })).toBeVisible({ timeout: 30_000 });
  await page
    .locator("#session-where")
    .getByRole("button", { name: /My machine/ })
    .click();
  const dirSelect = page.locator("#session-where select").nth(1);
  await expect(dirSelect).toBeVisible();
  await expect(dirSelect.locator("option", { hasText: "Add a directory" })).toHaveCount(0);
});
