/**
 * Add repository with two GitLab servers: the GitLab picker shows a button
 * per server and lists the projects of the one clicked. The servers
 * themselves are stubbed at the browser (the e2e stack reaches no GitLab).
 */
import { expect, test } from "@playwright/test";

const HOSTS = ["gitlab.corp.example", "git.lab.example"];
const PROJECTS: Record<string, string[]> = {
  "gitlab.corp.example": ["platform/api", "platform/web", "infra/helm-charts"],
  "git.lab.example": ["research/models", "research/notebooks"],
};

test("picks between two GitLab servers when adding a repository @form-logic", async ({ page }) => {
  await page.route("**/api/secrets*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const body = (await res.json()) as { secrets: Array<Record<string, unknown>> };
    body.secrets = [...(body.secrets ?? []), { id: "stub", name: "GITLAB_TOKEN", scope: "global" }];
    return route.fulfill({ response: res, json: body });
  });
  const asked: Array<string | null> = [];
  await page.route("**/api/repos/browse*", (route) => {
    const url = new URL(route.request().url());
    const host = url.searchParams.get("host") ?? HOSTS[0];
    asked.push(url.searchParams.get("host"));
    return route.fulfill({
      json: {
        platform: "gitlab",
        host,
        hosts: HOSTS,
        repos: PROJECTS[host].map((fullName) => ({
          fullName,
          cloneUrl: `https://${host}/${fullName}.git`,
          htmlUrl: `https://${host}/${fullName}`,
          defaultBranch: "main",
          isPrivate: true,
          description: null,
          pushedAt: null,
        })),
      },
    });
  });

  await page.goto("/repos/new");
  await page.getByRole("button", { name: "GitLab", exact: true }).click();

  const servers = page.getByRole("group", { name: "GitLab server" });
  await expect(servers.getByRole("button", { name: HOSTS[0] })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("option", { name: /platform\/api/ })).toBeVisible();

  await servers.getByRole("button", { name: HOSTS[1] }).click();
  await expect(servers.getByRole("button", { name: HOSTS[1] })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("option", { name: /research\/models/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /platform\/api/ })).toHaveCount(0);
  expect(asked.at(-1)).toBe(HOSTS[1]);

  if (process.env.OPTIO_E2E_SCREENSHOT) {
    await page.screenshot({ path: process.env.OPTIO_E2E_SCREENSHOT, fullPage: true });
  }

  // The picked project's URL is on the server that was chosen.
  await page.getByRole("option", { name: /research\/models/ }).click();
  await expect(page.getByLabel("Repository URL")).toHaveValue(
    `https://${HOSTS[1]}/research/models`,
  );
});
