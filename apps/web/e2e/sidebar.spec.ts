import { expect, test, type APIRequestContext } from "@playwright/test";

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
  await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toBeHidden();
  await sidebar.getByRole("button", { name: "Account menu" }).click();
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
  // Settings lives in the account menu, with no duplicate permanent footer row.
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
  await expect(sidebar.getByRole("button", { name: "Optio navigation" })).toBeFocused();
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

test("the Optio menu shares the dashboard destinations and supports keyboard navigation", async ({
  page,
}) => {
  await page.goto("/work");
  const trigger = page.getByRole("button", { name: "Optio navigation" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const navigation = page.getByRole("navigation", { name: "App navigation" });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Work", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.keyboard.press("Tab");
  await expect(navigation.getByRole("link", { name: "Overview", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await navigation.getByRole("link", { name: "Pull requests", exact: true }).click();
  await expect(page).toHaveURL(/\/reviews$/);
  await expect(navigation).toBeHidden();
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Pull requests", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});

const API = "http://127.0.0.1:4931";

async function createSession(request: APIRequestContext, kind: "local" | "pod") {
  if (kind === "pod") {
    const response = await request.post(`${API}/api/sessions`, {
      data: { repoUrl: "https://github.com/e2e/sidebar", title: "Shared sidebar session" },
    });
    expect(response.ok()).toBe(true);
    const { session } = await response.json();
    return {
      href: `/work/${session.id}`,
      row: `a[href="/work/${session.id}"]`,
      done: () => request.post(`${API}/api/sessions/${session.id}/end`),
    };
  }
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const laptop = hosts.find((host: { name: string }) => host.name === "E2E laptop");
  const response = await request.post(`${API}/api/local/terminals`, {
    data: {
      hostId: laptop.id,
      dir: "/Users/e2e/notes",
      title: "Shared sidebar session",
      spec: { kind: "shell" },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { terminal } = await response.json();
  return {
    href: `/work/${terminal.id}`,
    row: `[data-terminal-id="${terminal.id}"]`,
    done: () => request.delete(`${API}/api/local/terminals/${terminal.id}`),
  };
}

for (const kind of ["local", "pod"] as const) {
  test(`${kind} sessions share navigation and account controls, with scoped search and an accessible drawer`, async ({
    page,
    request,
  }, testInfo) => {
    const session = await createSession(request, kind);
    await page.route("**/api/workspaces", (route) =>
      route.fulfill({
        json: {
          workspaces: [
            { id: "demo", name: "Acme", slug: "acme", role: "admin" },
            { id: "other", name: "Other workspace", slug: "other", role: "admin" },
          ],
        },
      }),
    );
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(session.href);
      const sidebar = page.getByRole("complementary", {
        name: "Session sidebar",
        includeHidden: true,
      });
      await expect(sidebar.getByRole("button", { name: "Switch workspace: Acme" })).toBeVisible();
      await expect(sidebar.getByRole("button", { name: /^Optio Agent/ })).toBeVisible();
      await expect(sidebar.getByRole("link", { name: "All work", exact: true })).toHaveAttribute(
        "href",
        "/work",
      );
      const search = sidebar.getByRole("searchbox", { name: "Search sessions", exact: true });
      const row = sidebar.locator(session.row);
      await expect(row).toBeVisible();
      await search.fill("no matching session");
      await expect(row).toBeHidden();
      await expect(sidebar.getByText("Nothing matches.", { exact: true })).toBeVisible();
      await sidebar.getByRole("button", { name: "Clear search sessions", exact: true }).click();
      await expect(search).toBeFocused();
      await expect(row).toBeVisible();

      const account = sidebar.getByRole("button", { name: "Account menu" });
      await account.click();
      await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toHaveCount(1);
      await sidebar.getByRole("button", { name: "Light", exact: true }).click();
      await expect(page.locator("html")).toHaveClass(/light/);
      await sidebar.getByText("Keyboard shortcuts", { exact: true }).click();
      await expect(sidebar.getByText("Hide sessions", { exact: true })).toBeVisible();
      if (kind === "local")
        await expect(sidebar.getByText("Switch session", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(account).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath(`${kind}-sidebar-light.png`),
        animations: "disabled",
      });
      await account.click();
      await sidebar.getByRole("button", { name: "Dark", exact: true }).click();
      await page.keyboard.press("Escape");

      const trigger = sidebar.getByRole("button", { name: "Optio navigation" });
      await trigger.click();
      const navigation = sidebar.getByRole("navigation", { name: "App navigation" });
      await expect(navigation.getByRole("link", { name: "Work", exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await page.screenshot({
        path: testInfo.outputPath(`${kind}-sidebar-navigation.png`),
        animations: "disabled",
      });
      await navigation.getByRole("link", { name: "Pull requests", exact: true }).click();
      await expect(page).toHaveURL(/\/reviews$/);

      await page.goto(session.href);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(sidebar).toBeHidden();
      const opener = page.getByRole("button", { name: "Open menu", exact: true });
      await opener.click();
      await expect(sidebar.getByRole("button", { name: "Close menu" })).toBeFocused();
      const workspace = sidebar.getByRole("button", { name: "Switch workspace: Acme" });
      await workspace.click();
      // Escape before the menu has opened is meant for the drawer, and closes it.
      await expect(workspace).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(workspace).toHaveAttribute("aria-expanded", "false");
      await expect(workspace).toBeFocused();
      await expect(sidebar).toBeVisible();
      await account.click();
      await expect(account).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(account).toHaveAttribute("aria-expanded", "false");
      await expect(sidebar).toBeVisible();
      await account.focus();
      await page.keyboard.press("Tab");
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(account).toBeFocused();
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(navigation).toBeHidden();
      await expect(sidebar).toBeVisible();
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(sidebar).toBeHidden();
      await expect(opener).toBeFocused();
      await opener.click();
      await trigger.click();
      await navigation.getByRole("link", { name: "Work", exact: true }).click();
      await expect(page).toHaveURL(/\/work$/);
      await expect(
        page.getByRole("complementary", { name: "Sidebar", includeHidden: true }),
      ).toBeHidden();
      await expect(page.getByRole("searchbox", { name: "Search work", exact: true })).toBeVisible();
      await expect(
        page.getByRole("searchbox", { name: "Search sessions", exact: true }),
      ).toBeHidden();

      // Switching workspace leaves the old workspace's session detail.
      await page.route("**/api/workspaces/other/switch", (route) =>
        route.fulfill({ json: { ok: true } }),
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(session.href);
      await workspace.click();
      await sidebar.getByRole("button", { name: "Other workspace admin", exact: true }).click();
      await expect(page).toHaveURL(/\/work$/);
      await expect(
        page.getByRole("button", { name: "Switch workspace: Other workspace" }),
      ).toBeVisible();
    } finally {
      await session.done();
    }
  });
}

test("account settings use shared theme controls and fit a small screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto("/work");
  await page.getByRole("button", { name: "Open menu" }).click();
  const account = page.getByRole("button", { name: "Account menu" });
  await account.click();
  const popup = page.getByRole("region", { name: "Account settings" });
  await expect(popup).toBeVisible();
  const theme = popup.getByRole("group", { name: "Theme", exact: true });
  await theme.getByRole("button", { name: "Light", exact: true }).click();
  await expect(theme.getByRole("button", { name: "Light", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("html")).toHaveClass(/light/);
  const box = (await popup.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: "/tmp/optio-account-menu-light.png" });
  await theme.getByRole("button", { name: "Dark", exact: true }).click();
  await page.screenshot({ path: "/tmp/optio-account-menu-dark.png" });
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(account).toBeFocused();
});
