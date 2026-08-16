/**
 * Smoke navigation across every top-level page: each must render its shell
 * and content (or a designed empty state) — never a crash, error boundary,
 * or unexpected redirect to /login or /setup.
 *
 * The stack is seeded (see launch-stack.ts) with: one repo, a pr_opened task,
 * a failed task, a completed job run, a prompt template, and a persistent
 * agent — so the data-bearing pages exercise their non-empty paths.
 */
import { expect, test, type Page } from "@playwright/test";

async function expectNoAuthOrSetupRedirect(page: Page) {
  await expect(page).not.toHaveURL(/\/(login|setup)/);
}

test("overview dashboard renders with seeded stats", async ({ page }) => {
  await page.goto("/");
  await expectNoAuthOrSetupRedirect(page);
  // Positive marker first: the seeded tasks must actually surface on the
  // dashboard — a crashed page or stuck skeleton would otherwise pass the
  // negative hero check below.
  await expect(
    page
      .locator("main")
      .getByText(/E2E: opens a PR|Tasks/)
      .first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Something went wrong")).not.toBeVisible();
  // Seeded tasks exist, so the dashboard (not the welcome hero) renders.
  await expect(page.getByText("Create your first task")).not.toBeVisible();
});

test("tasks list shows the seeded tasks", async ({ page }) => {
  await page.goto("/tasks");
  await expectNoAuthOrSetupRedirect(page);
  await expect(page.getByText("E2E: opens a PR").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("E2E: fails").first()).toBeVisible();
});

test("task detail shows mock agent logs", async ({ page }) => {
  await page.goto("/tasks");
  await page.getByText("E2E: opens a PR").first().click();
  await expect(page).toHaveURL(/\/tasks\//);
  await expect(page.getByText("Mock agent handled").first()).toBeVisible({ timeout: 20_000 });
});

test("jobs page shows the seeded job", async ({ page }) => {
  await page.goto("/jobs");
  await expectNoAuthOrSetupRedirect(page);
  await expect(page.getByText("E2E seed job").first()).toBeVisible({ timeout: 30_000 });
});

test("agents page shows the seeded persistent agent", async ({ page }) => {
  await page.goto("/agents");
  await expectNoAuthOrSetupRedirect(page);
  // First visit compiles the page in next dev — allow for that.
  await expect(page.getByText("e2e-seed-agent").first()).toBeVisible({ timeout: 30_000 });
});

test("templates page shows the seeded prompt", async ({ page }) => {
  await page.goto("/templates");
  await expectNoAuthOrSetupRedirect(page);
  // The prompt-templates API stores per-kind defaults (the provided name is
  // not displayed), so assert on the template CONTENT.
  await expect(page.getByText("Do the thing").first()).toBeVisible({ timeout: 30_000 });
});

for (const { path, marker } of [
  { path: "/tasks/scheduled", marker: /No scheduled tasks yet|Scheduled/i },
  { path: "/reviews", marker: /No open pull requests found|pull request/i },
  { path: "/issues", marker: /No open issues found|issues/i },
  { path: "/sessions", marker: /No sessions yet|Sessions/i },
  { path: "/costs", marker: /cost/i },
  { path: "/repos", marker: /e2e-org\/e2e-repo/ },
  { path: "/connections", marker: /connection/i },
  { path: "/secrets", marker: /GITHUB_TOKEN/ },
  { path: "/settings", marker: /settings/i },
]) {
  test(`page ${path} renders`, async ({ page }) => {
    await page.goto(path);
    await expectNoAuthOrSetupRedirect(page);
    // Scope to the content area — sidebar labels match several markers, which
    // would make these assertions pass even when the page itself crashed.
    await expect(page.locator("main").getByText(marker).first()).toBeVisible({ timeout: 30_000 });
  });
}
