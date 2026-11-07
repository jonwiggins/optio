/**
 * Settings → Integrations → Tickets: a self-hosted Jira Data Center provider.
 * Picking "Data Center / Server" swaps Cloud's email + API token for a
 * username + password, or a personal access token alone; the saved row says
 * it is Data Center, and the API keeps the token to itself.
 */
import { expect, test } from "@playwright/test";

import { API } from "./stack-ports";
const stamp = Date.now().toString(36);
const BASE_URL = `https://jira-${stamp}.corp.example/jira`;
const PAT = `e2e-dc-pat-${stamp}`;

test.afterAll(async () => {
  const res = await fetch(`${API}/api/tickets/providers`);
  const { providers } = (await res.json()) as {
    providers: Array<{ id: string; config: { baseUrl?: string } }>;
  };
  for (const p of providers.filter((p) => p.config.baseUrl === BASE_URL)) {
    await fetch(`${API}/api/tickets/providers/${p.id}`, { method: "DELETE" });
  }
});

test("adds a Jira Data Center provider with a personal access token @form-logic", async ({
  page,
}) => {
  await page.goto("/settings#integrations");
  // The Tickets card (Model providers has an "Add Provider" button too).
  const tickets = page.locator("section:not(:has(section))").filter({
    has: page.getByRole("heading", { name: "Tickets", exact: true }),
  });
  await tickets.getByRole("button", { name: "Add Provider" }).first().click();
  await tickets
    .getByRole("group", { name: "Provider" })
    .getByRole("button", { name: "Jira" })
    .click();

  // Cloud first: an account email and an API token.
  await expect(tickets.getByLabel("Account email")).toBeVisible();
  await expect(tickets.getByLabel("API token")).toBeVisible();

  await tickets.getByRole("button", { name: "Data Center / Server" }).click();
  await expect(tickets.getByLabel("Account email")).toHaveCount(0);
  await expect(tickets.getByLabel("Username (login)")).toBeVisible();
  await expect(tickets.getByLabel("Password", { exact: true })).toBeVisible();

  await tickets.getByRole("button", { name: "Personal access token" }).click();
  await expect(tickets.getByLabel("Username (login)")).toHaveCount(0);

  await tickets.getByLabel("Jira URL").fill(BASE_URL);
  await tickets.getByLabel("Personal access token", { exact: true }).fill(PAT);
  await tickets.getByLabel("Project key (optional)").fill("OPS");
  await tickets.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("Ticket provider added")).toBeVisible();
  await expect(tickets.getByText(`${BASE_URL} · Data Center`)).toBeVisible();

  const res = await fetch(`${API}/api/tickets/providers`);
  const body = await res.text();
  expect(body).not.toContain(PAT);
  const saved = (JSON.parse(body).providers as any[]).find((p) => p.config.baseUrl === BASE_URL);
  expect(saved).toMatchObject({
    hasToken: true,
    config: { flavor: "data-center", authType: "pat", projectKey: "OPS", label: "optio" },
  });
});
