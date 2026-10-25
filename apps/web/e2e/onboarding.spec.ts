/**
 * The getting-started guide switch (Settings → Access → Getting-started
 * guide): off by default, so the account menu has no Help and /help says the
 * guide is off; a deployment admin turning it on brings Help → Using Optio
 * and the guide itself. The e2e stack runs with auth disabled (one viewer,
 * a deployment admin, and no person to keep a checklist for), so the
 * Overview's checklist is covered by the web's unit tests. The switch goes
 * back to the deployment's default afterwards, so the other specs see
 * default menus.
 */
import { expect, test, type Page } from "@playwright/test";

const API = "http://127.0.0.1:4931";

async function setOnboarding(value: boolean | null): Promise<void> {
  const res = await fetch(`${API}/api/deployment-settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ onboarding: value }),
  });
  if (!res.ok) throw new Error(`PUT /api/deployment-settings → ${res.status}`);
}

async function openAccountMenu(page: Page) {
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await sidebar.getByRole("button", { name: "Account menu" }).click();
  const popup = page.getByRole("region", { name: "Account settings" });
  await expect(popup).toBeVisible();
  return popup;
}

test.describe("Getting-started guide", () => {
  test.beforeAll(async () => setOnboarding(null));
  test.afterAll(async () => setOnboarding(null));

  test("off by default: no Help in the account menu, and /help says the guide is off", async ({
    page,
  }) => {
    await page.goto("/work");
    const popup = await openAccountMenu(page);
    await expect(popup.getByRole("group", { name: "Theme", exact: true })).toBeVisible();
    await expect(popup.getByRole("navigation", { name: "Help" })).toHaveCount(0);
    await expect(popup.getByRole("link", { name: "Using Optio" })).toHaveCount(0);

    await page.goto("/help");
    await expect(page.getByText("The guide is off")).toBeVisible({ timeout: 30_000 });
  });

  test("turned on in Settings → Access: Help → Using Optio opens the guide", async ({ page }) => {
    await page.goto("/settings#access");
    const toggle = page.getByRole("group", { name: "Show the getting-started guide" });
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(toggle.getByRole("button", { name: /^Follow the deployment/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await toggle.getByRole("button", { name: "On", exact: true }).click();
    await expect(toggle.getByRole("button", { name: "On", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.goto("/work");
    const popup = await openAccountMenu(page);
    const help = popup.getByRole("navigation", { name: "Help" });
    await expect(help).toBeVisible();
    await help.getByRole("link", { name: "Using Optio" }).click();
    await expect(page).toHaveURL(/\/help$/);
    await expect(page.getByRole("heading", { name: "Using Optio" }).first()).toBeVisible();
    await expect(page.getByText("The guide is off")).toHaveCount(0);
  });
});
