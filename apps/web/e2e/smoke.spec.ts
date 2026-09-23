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
      .getByText(/Active now|E2E: opens a PR/)
      .first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Something went wrong")).not.toBeVisible();
  // Seeded tasks exist, so the dashboard (not the welcome hero) renders.
  await expect(page.getByText("Create your first task")).not.toBeVisible();
});

test("work list shows the seeded tasks, job, and agent", async ({ page }) => {
  await page.goto("/work?view=all");
  await expectNoAuthOrSetupRedirect(page);
  await expect(page.getByText("E2E: opens a PR").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("E2E: fails").first()).toBeVisible();
  await expect(page.getByText("E2E seed job").first()).toBeVisible();
  await expect(page.getByText("e2e-seed-agent").first()).toBeVisible();
});

test("task detail shows mock agent logs and links back to Work", async ({ page }) => {
  await page.goto("/work?view=all");
  await page.getByText("E2E: opens a PR").first().click();
  await expect(page).toHaveURL(/\/tasks\//);
  await expect(page.getByText("Mock agent handled").first()).toBeVisible({ timeout: 20_000 });
  await page.locator("main").getByRole("link", { name: "Work" }).first().click();
  await expect(page).toHaveURL(/\/work/);
});

test("a recurring row opens the job's page; its pencil opens the edit form", async ({ page }) => {
  await page.goto("/work?view=recurring");
  await page.getByText("E2E seed job").first().click();
  await expect(page).toHaveURL(/\/jobs\//);
  await page.locator("main").getByRole("link", { name: "Work" }).first().click();
  await expect(page).toHaveURL(/\/work\?view=recurring/);
  await page.getByRole("button", { name: "Edit E2E seed job" }).click();
  await expect(page).toHaveURL(/\/work\/[0-9a-f-]{36}\/edit$/);
  await expect(page.getByRole("heading", { name: "Edit work" })).toBeVisible();
});

test("agent detail links back to the agents view", async ({ page }) => {
  await page.goto("/work?view=agents");
  await page.getByText("e2e-seed-agent").first().click();
  await expect(page).toHaveURL(/\/agents\//);
  await page.locator("main").getByRole("link", { name: "Work" }).first().click();
  await expect(page).toHaveURL(/\/work\?view=agents/);
});

// The per-kind lists are gone; their URLs land on the matching Work view.
for (const { from, to } of [
  { from: "/tasks", to: /\/work\?view=active$/ },
  { from: "/tasks?tab=standalone", to: /\/work\?view=recurring$/ },
  { from: "/tasks?tab=prs", to: /\/reviews$/ },
  { from: "/jobs", to: /\/work\?view=recurring$/ },
  { from: "/tasks/scheduled", to: /\/work\?view=recurring$/ },
  { from: "/agents", to: /\/work\?view=agents$/ },
  { from: "/local", to: /\/work$/ },
  { from: "/local?new=1", to: /\/work\/new$/ },
  { from: "/sessions", to: /\/work$/ },
  { from: "/sessions?view=recurring", to: /\/work\?view=recurring$/ },
  { from: "/sessions/new", to: /\/work\/new$/ },
]) {
  test(`legacy ${from} redirects to ${to}`, async ({ page }) => {
    await page.goto(from);
    await expect(page).toHaveURL(to, { timeout: 30_000 });
  });
}

test("templates page shows the seeded prompt", async ({ page }) => {
  await page.goto("/templates");
  await expectNoAuthOrSetupRedirect(page);
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "E2E seed prompt" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(main.getByText("Do the thing: {{thing}}").first()).toBeVisible();
});

for (const { path, marker } of [
  { path: "/reviews", marker: /No open pull requests found|pull request/i },
  { path: "/issues", marker: /No open issues found|issues/i },
  { path: "/work", marker: /E2E: opens a PR|Work/i },
  { path: "/work?view=all", marker: /E2E: opens a PR/ },
  { path: "/work/new", marker: /New work/ },
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
