import { expect, test } from "@playwright/test";
import { prInboxFixture } from "./pr-inbox-fixture";

/**
 * The pull-request panel (/reviews) over a fixed /api/pr-inbox answer: the
 * whose-move sections, the view switch, filters, the per-row buttons and the
 * "who are you" step. The derivation itself is unit-tested in @optio/shared.
 */

test("groups PRs by whose move it is, with one next step each", async ({ page }) => {
  await page.route("**/api/pr-inbox?*", (route) => route.fulfill({ json: prInboxFixture() }));
  await page.route("**/api/pr-inbox", (route) => route.fulfill({ json: prInboxFixture() }));
  await page.goto("/reviews");

  await expect(page.getByRole("heading", { name: "Pull requests" })).toBeVisible();
  const you = page.getByTestId("pr-section-you");
  await expect(you.getByTestId("pr-row").first()).toHaveAttribute("data-action", "fix_ci");
  await expect(you.getByText("2 failing: Web E2E (Playwright 3/6), Typecheck")).toBeVisible();
  await expect(you.getByRole("button", { name: "Fix with agent" })).toBeVisible();
  // Reviewing is a person's job first: the diff, with Optio's review beside it.
  const review = you.getByTestId("pr-row").filter({ hasText: "GitLab MR pipelines" });
  await expect(review.getByRole("link", { name: "Review", exact: true })).toHaveAttribute(
    "href",
    "https://github.com/acme/web/pull/745/files",
  );
  await expect(review.getByRole("button", { name: "Draft with Optio" })).toBeVisible();
  await expect(you.getByRole("link", { name: "Optio's draft" })).toHaveAttribute(
    "href",
    "/reviews/44444444-4444-4444-8444-444444444444",
  );
  await expect(you.getByRole("button", { name: "Merge" })).toBeVisible();
  // A draft isn't anyone's move.
  await expect(you.getByText("WIP: Terraform")).toHaveCount(0);
  await expect(
    page.getByTestId("pr-section-agent").getByRole("link", { name: "Watch agent" }),
  ).toHaveAttribute("href", "/work/55555555-5555-4555-8555-555555555555");
  // An unreadable repo is named, not silently missing.
  await expect(page.getByText(/Couldn.t read acme\/legacy/)).toBeVisible();
  // Someone else's PR the viewer has no part in is only under All on my repos.
  await expect(page.getByText("Dark mode for the usage charts")).toHaveCount(0);
  await page.getByRole("button", { name: /All on my repos/ }).click();
  await expect(page).toHaveURL(/lens=all/);
  await expect(page.getByText("Dark mode for the usage charts")).toBeVisible();

  // Filters narrow every section.
  await page.getByRole("searchbox", { name: "Filter pull requests" }).fill("#91");
  await expect(page.getByTestId("pr-row")).toHaveCount(1);
  await expect(page.getByTestId("pr-row")).toHaveAttribute("data-action", "resolve_conflicts");
});

test("headline tiles narrow the list and offer bulk actions; lenses group by relation", async ({
  page,
}) => {
  await page.route("**/api/pr-inbox*", (route) => route.fulfill({ json: prInboxFixture() }));
  const sent: unknown[] = [];
  await page.route("**/api/pr-inbox/actions", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { message: "Re-running the failed run" } });
  });
  await page.goto("/reviews?lens=all");

  // CI failing: #742, #729 (the agent's), #701 (someone else's).
  const ci = page.getByTestId("pr-tile-ci");
  await expect(ci).toContainText("3");
  await ci.click();
  await expect(page).toHaveURL(/bucket=ci/);
  await expect(ci).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("pr-bucket-ci").getByTestId("pr-row")).toHaveCount(3);

  // Re-run failed checks on all of them, after a confirmation that lists them.
  await page.getByRole("button", { name: "Re-run failed checks (3)" }).click();
  await expect(page.getByText("#701 Dark mode for the usage charts")).toBeVisible();
  await page.getByRole("button", { name: "Re-run failed checks", exact: true }).click();
  await expect(page.getByText(/Re-run failed checks: done for 3 PRs/)).toBeVisible();
  expect(sent).toHaveLength(3);
  expect(sent[0]).toMatchObject({ action: "rerun_checks" });

  // Clicking the tile again clears it.
  await ci.click();
  await expect(page).not.toHaveURL(/bucket=/);

  // Review requested: only what's asked of you.
  await page.getByRole("button", { name: /Review requested/ }).click();
  await expect(page.getByTestId("pr-row")).toHaveCount(2);
  await expect(page.getByText("GitLab MR pipelines")).toBeVisible();
  // Reviewed by me: the PR you asked changes on.
  await page.getByRole("button", { name: /Reviewed by me/ }).click();
  await expect(page.getByTestId("pr-row")).toHaveCount(1);
  await expect(page.getByText("Drop the legacy /api/task-configs alias")).toBeVisible();
});

test("the row menu offers every action the PR's state allows", async ({ page }) => {
  await page.route("**/api/pr-inbox*", (route) => route.fulfill({ json: prInboxFixture() }));
  let sent: unknown = null;
  await page.route("**/api/pr-inbox/actions", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { message: "Approved #745" } });
  });
  await page.goto("/reviews?lens=requested");
  await page.getByRole("button", { name: "More actions for #745" }).click();
  const menu = page.getByRole("menu", { name: "More actions for #745" });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Open the diff",
    "Approve",
    "Draft a review with Optio",
    "Copy link",
  ]);
  await menu.getByRole("menuitem", { name: "Approve" }).click();
  await expect(page.getByText("Approved #745")).toBeVisible();
  expect(sent).toEqual({ prUrl: "https://github.com/acme/web/pull/745", action: "approve" });
  await expect(menu).toHaveCount(0);
});

test("send to agent, then merge after confirming", async ({ page }) => {
  await page.route("**/api/pr-inbox*", (route) => route.fulfill({ json: prInboxFixture() }));
  let sent: unknown = null;
  await page.route("**/api/pr-inbox/agent", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { taskId: "t-9", mode: "created" } });
  });
  let merged: unknown = null;
  await page.route("**/api/pull-requests/merge", async (route) => {
    merged = route.request().postDataJSON();
    await route.fulfill({ json: { merged: true } });
  });
  await page.goto("/reviews");

  const ci = page.getByTestId("pr-row").filter({ hasText: "Redis cluster pub/sub" });
  await ci.getByRole("button", { name: "Fix with agent" }).click();
  await expect(page.getByText("An agent is on #742")).toBeVisible();
  expect(sent).toEqual({ prUrl: "https://github.com/acme/web/pull/742", action: "fix_ci" });

  const ready = page.getByTestId("pr-row").filter({ hasText: "Fix ⌥↑" });
  await ready.getByRole("button", { name: "Merge" }).click();
  await expect(page.getByText("Squash and merge #733?")).toBeVisible();
  await expect(page.getByText(/Into main · CI green · approved by @kim/)).toBeVisible();
  expect(merged).toBeNull();
  await page.getByRole("button", { name: "Squash and merge", exact: true }).click();
  await expect(page.getByText("Merged #733")).toBeVisible();
  // The head this page saw: the platform refuses if someone pushed since.
  expect(merged).toEqual({
    prUrl: "https://github.com/acme/web/pull/733",
    mergeMethod: "squash",
    expectedHeadSha: "abc123",
  });
});

test("asks who you are when it doesn't know, and remembers", async ({ page }) => {
  let known = false;
  await page.route("**/api/pr-inbox*", (route) =>
    route.fulfill({ json: prInboxFixture(known ? ["jon"] : []) }),
  );
  let saved: unknown = null;
  await page.route("**/api/pr-inbox/handles", async (route) => {
    saved = route.request().postDataJSON();
    known = true;
    await route.fulfill({ json: { handles: ["jon"], source: "linked" } });
  });
  await page.goto("/reviews");

  await expect(page.getByRole("heading", { name: "Who are you on GitHub?" })).toBeVisible();
  // Everything shows meanwhile, and the personal views explain why they're off.
  await expect(page.getByRole("button", { name: "Needs me", exact: true })).toBeDisabled();
  await expect(page.getByText("Dark mode for the usage charts")).toBeVisible();
  // The guess is filled in (not a placeholder), and an empty field can't be saved.
  const login = page.getByRole("textbox", { name: "GitHub login" });
  await expect(login).toHaveValue("jon");
  await login.fill("");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await login.fill("jon");
  await page.getByRole("button", { name: "Save" }).click();
  expect(saved).toEqual({ github: "jon" });
  await expect(page.getByRole("heading", { name: "Who are you on GitHub?" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Needs me/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("You are @jon")).toBeVisible();
});

test("fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/pr-inbox*", (route) => route.fulfill({ json: prInboxFixture() }));
  await page.goto("/reviews");
  await expect(page.getByTestId("pr-row").first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
