import { test, expect } from "@playwright/test";
import type { UsageResponse, UsageMetrics } from "@optio/shared";
const metrics: UsageMetrics = {
  tokens: 1200000,
  inputTokens: 1000000,
  outputTokens: 200000,
  cachedTokens: 500000,
  costUsd: "12.4",
  reportedCostUsd: "10",
  estimatedCostUsd: "2.4",
  runs: 8,
  completedRuns: 6,
  unpricedRuns: 1,
  unmeasuredRuns: 0,
  historicalRuns: 0,
  retryCostUsd: "0",
};
const entries = [
  {
    ...metrics,
    id: "11111111-1111-4111-8111-111111111111",
    kind: "person" as const,
    name: "Alex Morgan",
    avatarUrl: null,
    rank: 1,
    changePercent: 12,
    trend: [2, 4, 3, 7, 5, 8, 10],
  },
  {
    ...metrics,
    id: "22222222-2222-4222-8222-222222222222",
    kind: "work" as const,
    name: "Daily issue triage",
    spawnedBy: "manual",
    runtime: "claude-code",
    avatarUrl: null,
    rank: 2,
    changePercent: null,
    trend: [1, 3, 6, 4, 8, 6, 8],
    costUsd: null,
    estimatedCostUsd: null,
    reportedCostUsd: null,
  },
];
function fixture(): UsageResponse {
  return {
    start: "2026-10-01T00:00:00Z",
    end: "2026-10-07T23:00:00Z",
    summary: metrics,
    previous: metrics,
    daily: [2, 4, 3, 7, 5, 8, 10].map((n, i) => ({
      date: `2026-10-0${i + 1}`,
      tokens: n * 100000,
      costUsd: String(n / 2),
    })),
    leaderboard: entries,
    totalEntries: 2,
    page: 0,
    pageSize: 25,
    models: [
      { model: "claude-sonnet-5", tokens: 800000, costUsd: "10", runs: 5 },
      { model: "gpt-6.1-sol", tokens: 400000, costUsd: "2.4", runs: 3 },
    ],
    budgets: [],
    canManageBudgets: true,
    canInspect: true,
    activity: [
      {
        id: "a",
        name: "Triage open issues",
        href: "/work",
        tokens: 100000,
        costUsd: null,
        model: "gpt-6.1-sol",
        lastUsed: "2026-10-07T12:00:00Z",
      },
    ],
  };
}

test("legacy Costs link opens Usage against the real API", async ({ page }) => {
  await page.goto("/costs");
  await expect(page).toHaveURL(/\/usage$/);
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Usage leaderboard" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await page.getByRole("link", { name: "Trigger history" }).click();
  await expect(page.getByRole("heading", { name: "Trigger history", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});
test("mixed leaderboard filters, drilldown and budget targeting work on desktop and mobile", async ({
  page,
}) => {
  await page.route("**/api/analytics/usage?*", (route) => {
    const url = new URL(route.request().url());
    const data = fixture();
    const kind = url.searchParams.get("kind");
    data.leaderboard = entries.filter((e) => !kind || kind === "all" || e.kind === kind);
    return route.fulfill({ json: data });
  });
  await page.goto("/usage");
  await expect(page.getByRole("button", { name: /Alex Morgan/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Daily issue triage/ })).toBeVisible();
  await expect(page.getByTitle("Started by manual", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "—", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "1.2M 1M in · 200K out", exact: true })).toHaveCount(
    2,
  );
  await expect(page.getByRole("columnheader", { name: "Cost*", exact: true })).toBeVisible();
  await expect(page.getByText(/A dash means no cost or estimate is available/)).toBeVisible();
  await page.getByRole("button", { name: "Organization work", exact: true }).click();
  await expect(page.getByRole("button", { name: /Alex Morgan/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Daily issue triage/ }).click();
  await expect(
    page.getByRole("heading", { name: /Daily issue triage · Recent activity/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Set budget", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Monthly token limit").fill("2000000");
  await page.getByLabel("When either limit is reached").selectOption("pause_new");
  let saved: Record<string, unknown> | undefined;
  await page.route("**/api/usage/budgets", (route) => {
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { budgets: [] } });
  });
  await page.getByRole("button", { name: "Save budget" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(saved).toMatchObject({
    subjectKind: "work",
    subjectId: entries[1].id,
    tokenLimit: 2000000,
    action: "pause_new",
  });
  await page.getByRole("button", { name: "Organization budget", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Organization budget", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Monthly cost limit (USD)").fill("50");
  await page.getByRole("button", { name: "Save budget" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(saved).toMatchObject({ subjectKind: "organization", subjectId: null });
  await page.getByRole("button", { name: /Clear selection/ }).click();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Usage leaderboard" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/optio-usage-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: "/tmp/optio-usage-desktop.png", fullPage: true });
});
test("a failed refresh remains visible and can be retried", async ({ page }) => {
  let fail = true;
  await page.route("**/api/analytics/usage?*", (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: "Usage is temporarily unavailable" } })
      : route.fulfill({ json: fixture() }),
  );
  await page.goto("/usage");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Usage is temporarily unavailable",
  );
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Usage leaderboard" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});
