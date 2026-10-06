import { expect, test } from "@playwright/test";

test("Library is discoverable, preferences persist, and the current section stays open", async ({
  page,
}) => {
  await page.goto("/work");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("link", { name: "Work", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(sidebar.getByRole("link", { name: "Prompts", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Analytics", exact: true })).toBeHidden();
  await sidebar.getByRole("button", { name: "Library", exact: true }).click();
  await page.reload();
  await expect(sidebar.getByRole("link", { name: "Prompts", exact: true })).toBeHidden();
  await page.goto("/templates");
  await expect(sidebar.getByRole("link", { name: "Prompts", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(sidebar.getByRole("button", { name: "Library", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
});

test("workspace and account controls close with Escape and return focus", async ({ page }) => {
  await page.route("**/api/workspaces", (route) =>
    route.fulfill({
      json: { workspaces: [{ id: "demo", name: "Acme", slug: "acme", role: "admin" }] },
    }),
  );
  await page.goto("/work");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const workspace = sidebar.getByRole("button", { name: "Switch workspace: Acme" });
  await workspace.click();
  await expect(workspace).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveAttribute("aria-expanded", "false");
  await expect(workspace).toBeFocused();
  const account = sidebar.getByRole("button", { name: "Account menu" });
  await account.click();
  await expect(sidebar.getByRole("button", { name: "Light", exact: true })).toBeVisible();
  // Settings has its own destination; it should not appear a second time in this menu.
  await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(account).toBeFocused();
  await expect(account).toHaveAttribute("aria-expanded", "false");
});

test("the mobile drawer contains keyboard focus and restores it when dismissed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/work");
  const sidebar = page.getByRole("complementary", { name: "Sidebar", includeHidden: true });
  await expect(sidebar).toBeHidden();
  const opener = page.getByRole("button", { name: "Open menu" });
  await opener.click();
  await expect(sidebar.getByRole("button", { name: "Close menu" })).toBeFocused();
  await sidebar.getByRole("button", { name: "Account menu" }).focus();
  await page.keyboard.press("Tab");
  await expect(sidebar.getByRole("link", { name: "Optio", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(sidebar.getByRole("button", { name: "Account menu" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sidebar).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await sidebar.getByRole("link", { name: "Prompts", exact: true }).click();
  await expect(page).toHaveURL(/\/templates$/);
  await expect(sidebar).toBeHidden();
});
