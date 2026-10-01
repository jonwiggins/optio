/**
 * The Machines page against the seeded stack: each machine lists the work
 * on it and the Optio pods list theirs; "Add machine" walks through pairing
 * with this server's own commands, and the seeded laptop — offline, since no
 * daemon runs here — says what to run instead of offering to change its
 * directories.
 */
import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:4931";

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  // No content-type on a bodiless request — Fastify 400s an empty JSON body.
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

test("each machine lists the work set up on it, and the pods list theirs", async ({ page }) => {
  const { hosts } = await api("/api/local/hosts");
  const host = hosts.find((h: any) => h.name === "E2E laptop");
  const name = `E2E machine automation ${Date.now().toString(36)}`;
  const { blueprint } = await api("/api/local/blueprints", {
    method: "POST",
    body: JSON.stringify({
      name,
      hostId: host.id,
      dir: "/Users/e2e/notes",
      commandTemplate: "Summarize {{title}}",
      agent: "claude-code",
      sessionMode: "headless",
    }),
  });

  await page.goto("/machines");
  const laptop = page.getByRole("region", { name: "E2E laptop", exact: true });
  const row = laptop.getByRole("link", { name: new RegExp(name) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute("href", `/local/automations/${blueprint.id}`);
  // Under its machine a row names only the directory.
  await expect(row.getByText("~/notes", { exact: true })).toBeVisible();
  await expect(laptop.getByText("Set up to run here")).toBeVisible();

  // The seeded persistent agent runs in a pod.
  await expect(page.getByRole("heading", { name: "Optio pods" })).toBeVisible();
  const agents = page.getByRole("region", { name: "Persistent agents", exact: true });
  await expect(agents.getByRole("link", { name: /e2e-seed-agent/ })).toBeVisible();
});

test("Add machine shows this server's pairing commands", async ({ page }) => {
  await page.goto("/machines");
  const main = page.locator("main");
  await expect(main.getByRole("heading", { name: "E2E laptop" })).toBeVisible({
    timeout: 30_000,
  });
  // Directories are the machine's setup, folded under it.
  await main
    .getByRole("region", { name: "E2E laptop", exact: true })
    .getByRole("button", { name: /Directories/ })
    .click();
  await expect(main.getByText(/E2E laptop is offline — start optio local up on it/)).toBeVisible();
  await expect(main.getByRole("button", { name: /Remove/ })).toHaveCount(0);

  await main.getByRole("button", { name: "Add machine" }).click();
  await expect(main.getByRole("heading", { name: "Pair another machine" })).toBeVisible();
  // Auth is off in this stack: no sign-in step, and the daemon names the server.
  await expect(main.getByText("optio --server http://127.0.0.1:4931 local up")).toBeVisible();
  await expect(main.getByText(/optio login/)).toHaveCount(0);
  await expect(main.getByText("Waiting for a machine to connect…")).toBeVisible();

  await main.getByRole("button", { name: "Close" }).click();
  await expect(main.getByRole("heading", { name: "Pair another machine" })).toHaveCount(0);
});

test("the New work form offers no directory it can't add on an offline machine", async ({
  page,
}) => {
  await page.goto("/work/new");
  await expect(page.getByRole("heading", { name: "New work" })).toBeVisible({ timeout: 30_000 });
  await page
    .locator("#session-where")
    .getByRole("button", { name: /My machine/ })
    .click();
  const dirSelect = page.locator("#session-where select").nth(1);
  await expect(dirSelect).toBeVisible();
  await expect(dirSelect.locator("option", { hasText: "Add a directory" })).toHaveCount(0);
});
