/**
 * The Work list has a way into the session screen (`/local/:id`, the
 * terminal with every session in its rail): the Sessions button, which opens
 * on the session that most needs you.
 */
import { expect, test } from "@playwright/test";

const API = "http://127.0.0.1:4931";

test("the Work list opens the session screen", async ({ page, request }) => {
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const laptop = hosts.find((h: { name: string }) => h.name === "E2E laptop");
  // A session on the seeded laptop (offline, so it waits for the machine).
  const created = await request.post(`${API}/api/local/terminals`, {
    data: {
      hostId: laptop.id,
      dir: "/Users/e2e/notes",
      title: "via Sessions",
      spec: { kind: "shell" },
    },
  });
  expect(created.ok()).toBe(true);
  const { terminal } = await created.json();

  await page.goto("/work");
  await page.getByRole("link", { name: /^Sessions/ }).click();
  await expect(page).toHaveURL(/\/local\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  // The session screen: its rail lists the sessions.
  await expect(page.getByRole("searchbox", { name: "Search sessions" })).toBeVisible();
  await expect(page.getByRole("button", { name: /via Sessions/ })).toBeVisible();

  await request.delete(`${API}/api/local/terminals/${terminal.id}`);
});
