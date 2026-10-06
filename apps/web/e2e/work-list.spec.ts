import { expect, test } from "@playwright/test";
import type { WorkRow } from "@optio/shared";

function row(
  id: string,
  name: string,
  status: WorkRow["status"],
  extra: Partial<WorkRow> = {},
): WorkRow {
  return {
    key: id,
    id,
    name,
    source: "repo-task",
    href: `/tasks/${id}`,
    when: "now",
    where: { target: "pod", detail: "acme/platform" },
    who: "codex",
    then: "until-merged",
    status,
    statusLabel: status === "needs_you" ? "Needs your input" : status,
    note: null,
    prUrl: null,
    lastActivity: new Date().toISOString(),
    recurring: false,
    spawned: false,
    editHref: null,
    ...extra,
  };
}

const rows = [
  row("review", "Review the authentication update", "needs_you", {
    note: "Changes are ready for your review",
    prUrl: "https://github.com/acme/platform/pull/42",
  }),
  row("running", "Improve onboarding accessibility", "running"),
  row("queued", "Update the billing integration", "queued"),
  row("session", "Explore the new API", "waiting", {
    source: "local-terminal",
    href: "/local/session",
    who: "claude-code",
    then: "waits-for-me",
    where: { target: "machine", detail: "MacBook · ~/projects/platform" },
  }),
  row("schedule", "Daily dependency check", "scheduled", {
    recurring: true,
    source: "standalone",
    when: "on a trigger",
    triggers: [{ type: "schedule" }],
    then: "exits",
    editHref: "/work/schedule/edit",
  }),
  row("done", "Add workspace invitations", "done"),
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/work", (route) => route.fulfill({ json: { rows } }));
});

test("summary filters, search reset, and browser navigation stay in sync", async ({ page }) => {
  await page.goto("/work");
  await expect(page.locator("article")).toHaveCount(4);
  await page
    .getByRole("group", { name: "Work summary" })
    .getByRole("button", { name: /^Needs you/ })
    .click();
  await expect(page).toHaveURL(/focus=needs_you/);
  await expect(page.locator("article")).toHaveCount(1);
  await page.reload();
  await expect(
    page.getByRole("group", { name: "Work summary" }).getByRole("button", { name: /^Needs you/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("navigation", { name: "Work views" })
    .getByRole("button", { name: /^Recurring/ })
    .click();
  await expect(page.locator("article")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Edit Daily dependency check" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("link", { name: "Review the authentication update" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search work" }).fill("no such work");
  await expect(page.getByRole("heading", { name: "No matching work" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters", exact: true }).first().click();
  await expect(page.locator("article")).toHaveCount(4);
  await page.getByRole("button", { name: /^In progress/ }).click();
  await expect(page.locator("article")).toHaveCount(2);
});

test("row links are independent and bulk actions state their scope", async ({ page }) => {
  await page.goto("/work");
  const work = page.locator("article").filter({ hasText: "Review the authentication update" });
  await expect(work.getByRole("link", { name: "PR", exact: true })).toHaveAttribute(
    "href",
    rows[0].prUrl!,
  );
  await expect(work.locator("a a, a button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel all active tasks" })).not.toBeVisible();
  await page.locator("summary").filter({ hasText: "Task actions" }).click();
  await expect(
    page.getByText("Applies to all eligible repo tasks, including those outside these filters."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel all active tasks" })).toBeVisible();
});

test("failed fetch offers recovery instead of a misleading empty state", async ({ page }) => {
  await page.route("**/api/work", (route) =>
    route.fulfill({ status: 503, json: { message: "Temporarily unavailable" } }),
  );
  await page.goto("/work");
  await expect(page.locator("main").getByRole("alert")).toContainText("Couldn’t refresh work");
  await expect(page.getByText("You’re all caught up")).not.toBeVisible();
  await page.route("**/api/work", (route) => route.fulfill({ json: { rows } }));
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("article")).toHaveCount(4);
});

test("phone layout stays within the viewport and keeps filters reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/work");
  await expect(page.locator("article")).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  for (const article of await page.locator("article").all()) {
    const box = await article.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  await page
    .getByRole("navigation", { name: "Work views" })
    .getByRole("button", { name: /^History/ })
    .click();
  await expect(page.getByRole("link", { name: "Add workspace invitations" })).toBeVisible();
});
