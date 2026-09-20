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
      .getByText(/Active sessions|E2E: opens a PR/)
      .first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Something went wrong")).not.toBeVisible();
  // Seeded tasks exist, so the dashboard (not the welcome hero) renders.
  await expect(page.getByText("Create your first task")).not.toBeVisible();
});

test("sessions list shows the seeded tasks, job, and agent", async ({ page }) => {
  await page.goto("/sessions?view=all");
  await expectNoAuthOrSetupRedirect(page);
  await expect(page.getByText("E2E: opens a PR").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("E2E: fails").first()).toBeVisible();
  await expect(page.getByText("E2E seed job").first()).toBeVisible();
  await expect(page.getByText("e2e-seed-agent").first()).toBeVisible();
});

test("task detail shows mock agent logs and links back to Sessions", async ({ page }) => {
  await page.goto("/sessions?view=all");
  await page.getByText("E2E: opens a PR").first().click();
  await expect(page).toHaveURL(/\/tasks\//);
  await expect(page.getByText("Mock agent handled").first()).toBeVisible({ timeout: 20_000 });
  await page.locator("main").getByRole("link", { name: "Sessions" }).first().click();
  await expect(page).toHaveURL(/\/sessions/);
});

test("job detail links back to the recurring view", async ({ page }) => {
  await page.goto("/sessions?view=recurring");
  await page.getByText("E2E seed job").first().click();
  await expect(page).toHaveURL(/\/jobs\//);
  await page.locator("main").getByRole("link", { name: "Sessions" }).first().click();
  await expect(page).toHaveURL(/\/sessions\?view=recurring/);
});

test("agent detail links back to the agents view", async ({ page }) => {
  await page.goto("/sessions?view=agents");
  await page.getByText("e2e-seed-agent").first().click();
  await expect(page).toHaveURL(/\/agents\//);
  await page.locator("main").getByRole("link", { name: "Sessions" }).first().click();
  await expect(page).toHaveURL(/\/sessions\?view=agents/);
});

// The per-kind lists are gone; their URLs land on the matching Sessions view.
for (const { from, to } of [
  { from: "/tasks", to: /\/sessions\?view=active$/ },
  { from: "/tasks?tab=standalone", to: /\/sessions\?view=recurring$/ },
  { from: "/tasks?tab=prs", to: /\/reviews$/ },
  { from: "/jobs", to: /\/sessions\?view=recurring$/ },
  { from: "/tasks/scheduled", to: /\/sessions\?view=recurring$/ },
  { from: "/agents", to: /\/sessions\?view=agents$/ },
  { from: "/local", to: /\/sessions$/ },
  { from: "/local?new=1", to: /\/sessions\/new$/ },
]) {
  test(`legacy ${from} redirects to ${to}`, async ({ page }) => {
    await page.goto(from);
    await expect(page).toHaveURL(to, { timeout: 30_000 });
  });
}

test("templates page shows the seeded prompt", async ({ page }) => {
  await page.goto("/templates");
  await expectNoAuthOrSetupRedirect(page);
  // The prompt-templates API stores per-kind defaults (the provided name is
  // not displayed), so assert on the template CONTENT.
  await expect(page.getByText("Do the thing").first()).toBeVisible({ timeout: 30_000 });
});

for (const { path, marker } of [
  { path: "/reviews", marker: /No open pull requests found|pull request/i },
  { path: "/issues", marker: /No open issues found|issues/i },
  { path: "/sessions", marker: /E2E: opens a PR|Sessions/i },
  { path: "/sessions?view=all", marker: /E2E: opens a PR/ },
  { path: "/sessions/new", marker: /New session/ },
  { path: "/machines", marker: /No machines paired|Machines/i },
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
