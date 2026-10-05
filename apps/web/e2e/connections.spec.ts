/**
 * Library → Connections: one page for everything work can be connected to.
 * The Connect gallery makes a provider connection (Pylon) and a bare secret;
 * each lands as a row with its subtext ("Organization · tools + credentials ·
 * Pylon"); the ⋯ menu's Edit opens the editor, where a saved token shows as
 * "Saved" and stays saved through a rename. Deployment secrets (GITHUB_TOKEN,
 * seeded by launch-stack.ts) never appear here. The API never returns a
 * secret's value.
 */
import { expect, test, type Page } from "@playwright/test";

const API = "http://127.0.0.1:4931";

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const stamp = Date.now().toString(36).toUpperCase();
const PYLON_NAME = `E2E Pylon ${stamp}`;
const PYLON_RENAMED = `E2E Pylon ${stamp} EU`;
const PYLON_TOKEN = `e2e-pylon-token-${stamp}`;
const SECRET_NAME = `E2E_STRIPE_KEY_${stamp}`;

/** The row whose name is `name`, exactly. */
function row(page: Page, name: string) {
  return page.getByTestId("connection-row").filter({
    has: page.getByText(name, { exact: true }),
  });
}

async function openConnections(page: Page, path = "/connections") {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe.serial("Connections", () => {
  test("Connect → Pylon makes a row with its subtext; the API never returns the token", async ({
    page,
  }) => {
    await openConnections(page);
    await page.getByRole("button", { name: "Connect", exact: true }).first().click();
    await expect(page.getByTestId("connect-gallery")).toBeVisible();
    await page.getByTestId("connect-tile-pylon").click();

    await page.getByLabel("Connection name").fill(PYLON_NAME);
    await page.locator("#connect-pylon-PYLON_API_TOKEN").fill(PYLON_TOKEN);
    await page.locator("#connect-pylon-PYLON_API_HOST").selectOption({ label: "EU" });
    // Pylon has a health check, so the button tests before it saves; the
    // test itself fails or passes against the real host — the row lands either way.
    await page.getByRole("button", { name: /^(Test & save|Save)$/ }).click();

    const pylon = row(page, PYLON_NAME);
    await expect(pylon).toBeVisible({ timeout: 60_000 });
    // Pylon ships an agent note, so its parts read "tools + credentials + note".
    await expect(
      pylon.getByText(/^Organization · tools \+ credentials( \+ note)? · Pylon$/),
    ).toBeVisible();

    const list = await api<{ connections: any[] }>("/api/connections");
    const mine = list.connections.find((c) => c.name === PYLON_NAME);
    expect(mine).toBeTruthy();
    expect(mine.secretFields).toContain("PYLON_API_TOKEN");
    expect(mine.config?.PYLON_API_HOST).toBe("api.eu.usepylon.com");
    expect(JSON.stringify(list)).not.toContain(PYLON_TOKEN);
  });

  test("the Secrets filter hides deployment secrets and lists a secret made from the gallery", async ({
    page,
  }) => {
    await openConnections(page, "/connections?kind=secret");
    await expect(
      page.getByTestId("connections-kind-filter").getByRole("button", { name: /^Secrets/ }),
    ).toHaveAttribute("aria-pressed", "true");
    // Seeded by launch-stack.ts, but the deployment's own: not something work connects to.
    await expect(page.locator("main").getByText("GITHUB_TOKEN", { exact: true })).toHaveCount(0);
    await expect(page.locator("main").getByText("ANTHROPIC_API_KEY", { exact: true })).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "Connect", exact: true }).first().click();
    await page.getByTestId("connect-tile-secret").click();
    await page.getByLabel("Secret name").fill(SECRET_NAME);
    await page.getByLabel("Secret value").fill("sk_test_e2e");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("connect-gallery")).toHaveCount(0);

    const secret = row(page, SECRET_NAME);
    await expect(secret).toBeVisible({ timeout: 30_000 });
    await expect(secret.getByText("Organization · credentials only · Secret")).toBeVisible();

    // The Services filter leaves it out; the Pylon connection stays.
    await page
      .getByTestId("connections-kind-filter")
      .getByRole("button", { name: /^Services/ })
      .click();
    await expect(page).toHaveURL(/[?&]kind=service/);
    await expect(row(page, SECRET_NAME)).toHaveCount(0);
    await expect(row(page, PYLON_NAME)).toBeVisible();
  });

  test("⋯ → Edit shows the saved token, renames the connection, keeps the token", async ({
    page,
  }) => {
    await openConnections(page, "/connections?kind=service");
    const pylon = row(page, PYLON_NAME);
    await expect(pylon).toBeVisible({ timeout: 30_000 });
    await pylon.getByRole("button", { name: `Actions for ${PYLON_NAME}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    const editor = page.getByTestId("connection-editor");
    await expect(editor).toBeVisible();
    await expect(editor.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 });
    await editor.getByLabel("Connection name").fill(PYLON_RENAMED);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);

    await expect(row(page, PYLON_RENAMED)).toBeVisible({ timeout: 30_000 });
    await expect(row(page, PYLON_NAME)).toHaveCount(0);

    const list = await api<{ connections: any[] }>("/api/connections");
    const mine = list.connections.find((c) => c.name === PYLON_RENAMED);
    expect(mine).toBeTruthy();
    const { connection } = await api<{ connection: any }>(`/api/connections/${mine.id}`);
    expect(connection.secretFields).toContain("PYLON_API_TOKEN");
    expect(JSON.stringify(connection)).not.toContain(PYLON_TOKEN);
  });
});
