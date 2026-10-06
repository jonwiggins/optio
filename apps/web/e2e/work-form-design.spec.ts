import { expect, test } from "@playwright/test";

test("starting points and the review panel help finish a draft without submitting it", async ({
  page,
}) => {
  await page.route("**/api/me/work-defaults", (route) => route.fulfill({ json: { defaults: {} } }));
  await page.goto("/work/new");
  await expect(page.locator("#session-where select").first()).toBeVisible();
  const presets = page.getByRole("region", { name: "Starting points" });
  await expect(presets.getByRole("button", { name: "Open a PR", exact: true })).toBeHidden();
  await presets.locator("summary").click();
  await presets.getByRole("button", { name: "Open a PR", exact: true }).click();
  await expect(presets.getByRole("button", { name: "Open a PR", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const summary = page.getByRole("complementary", { name: "Work summary" });
  await expect(page.locator('form button[type="submit"]')).toBeDisabled();
  await summary.getByRole("button", { name: "Add a prompt", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeFocused();
  await page
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Improve onboarding accessibility.");
  await expect(summary).toContainText("Improve onboarding accessibility.");
  await expect(page.locator('form button[type="submit"]')).toBeEnabled();
  await summary.getByRole("link").filter({ hasText: /Task/ }).first().click();
  await expect(page.getByRole("textbox", { name: "Work name", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "Work name", exact: true }).fill("Accessible onboarding");
  await expect(
    summary.getByRole("link", { name: "Accessible onboarding", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/work\/new$/);
});

test("on phones the prompt comes first and review remains reachable without horizontal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/work/new");
  await expect(page.locator("#session-where select").first()).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Starting points" })
      .getByRole("button", { name: "Open a PR", exact: true }),
  ).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeInViewport();
  await expect(page.locator("form section").first()).toHaveAttribute("id", "session-prompt");
  const main = page.locator("main");
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await page
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Improve onboarding accessibility.");
  const submit = page.locator('form button[type="submit"]');
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  await expect(submit).toBeEnabled();
});

test("Overview keeps account usage limit indicators when usage data is available", async ({
  page,
}) => {
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  await page.route("**/api/auth/usage", (route) =>
    route.fulfill({
      json: {
        usage: {
          available: true,
          fiveHour: { utilization: 37, resetsAt },
          sevenDay: { utilization: 62, resetsAt },
        },
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("37%", { exact: true })).toBeVisible();
  await expect(page.getByText("62%", { exact: true })).toBeVisible();
});
