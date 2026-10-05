/**
 * Organization / Private scope in the UI: the Connections page (secrets filter) is
 * sectioned by scope, its segments filter and live in the URL, the create
 * form carries the Owner picker, and the Prompts page and Settings → Sign-in
 * use the same pieces. The e2e stack runs with auth disabled (one viewer,
 * admin), so the multi-user rule itself is covered by the API's integration
 * tests; this checks the shapes every page renders.
 */
import { expect, test } from "@playwright/test";

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

test.describe("Scope", () => {
  test("Secrets (under Connections): sectioned by scope, segments filter via ?owner=, Owner picker in the gallery", async ({
    page,
  }) => {
    // One organization secret the seed didn't make, so the section has a known row.
    const orgName = `E2E_ORG_${stamp}`;
    await api("/api/secrets", {
      method: "POST",
      body: JSON.stringify({ name: orgName, value: "x" }),
    });

    // Secrets are rows of the Connections page; `?kind=secret` is its Secrets filter.
    await page.goto("/connections?kind=secret");
    await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    // The All view is sectioned: an Organization panel and a Private panel.
    await expect(page.getByRole("heading", { name: "Organization", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Private", exact: true })).toBeVisible();
    await expect(page.getByText(orgName, { exact: true })).toBeVisible();

    // The segments: Private shows no organization rows, and the choice is in the URL.
    const segments = page.getByRole("group", { name: "Filter by owner" });
    await expect(segments.getByRole("button", { name: /^All/ })).toBeVisible();
    await segments.getByRole("button", { name: /^Private/ }).click();
    await expect(page).toHaveURL(/[?&]owner=private/);
    await expect(page.getByText(orgName, { exact: true })).toHaveCount(0);
    await segments.getByRole("button", { name: /^Organization/ }).click();
    await expect(page).toHaveURL(/[?&]owner=organization/);
    await expect(page.getByText(orgName, { exact: true })).toBeVisible();

    // Deep link; both filters live in the URL.
    await page.goto("/connections?kind=secret&owner=private");
    await expect(
      page
        .getByRole("group", { name: "Filter by owner" })
        .getByRole("button", { name: /^Private/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByTestId("connections-kind-filter").getByRole("button", { name: /^Secrets/ }),
    ).toHaveAttribute("aria-pressed", "true");

    // The gallery's Secret form carries the Owner picker: Organization / Private, the vocabulary only.
    await page.goto("/connections?kind=secret");
    await page.getByRole("button", { name: "Connect", exact: true }).first().click();
    await page.getByTestId("connect-tile-secret").click();
    const owner = page.getByRole("group", { name: "Owner", exact: true });
    await expect(owner.getByRole("button", { name: "Organization" })).toBeVisible();
    await expect(owner.getByRole("button", { name: "Private" })).toBeVisible();
    await expect(page.getByText("Just me")).toHaveCount(0);

    // A private secret saved from the form lands in the list.
    const privateName = `E2E_PRIVATE_${stamp}`;
    await owner.getByRole("button", { name: "Private" }).click();
    await page.getByLabel("Secret name").fill(privateName);
    await page.getByLabel("Secret value").fill("shh");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("connect-gallery")).toHaveCount(0);
    // Exact: the save toast also mentions the name.
    await expect(page.getByText(privateName, { exact: true })).toBeVisible();
    // The stack runs with auth disabled, so there is no one for a private secret
    // to belong to: the API keeps it as the organization's (its documented
    // downgrade). The multi-user scope itself is covered by ownership.int.test.ts.
    const { secrets } = await api<{ secrets: Array<{ name: string; scope: string }> }>(
      "/api/secrets",
    );
    expect(secrets.some((s) => s.name === privateName)).toBe(true);
  });

  test("Prompts and the Work list carry the same owner segments", async ({ page }) => {
    await page.goto("/templates");
    await expect(page.getByRole("heading", { name: "Prompts", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("group", { name: "Filter by owner" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Organization", exact: true })).toBeVisible();

    // Nothing in the seed is private, so the Work list hides its owner filter.
    await page.goto("/work?view=all");
    await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("group", { name: "Filter by owner" })).toHaveCount(0);
  });

  test("Settings → Sign-in shows every provider and the Google form", async ({ page }) => {
    await page.goto("/settings");
    const card = page.locator("section", { hasText: "Sign-in" }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText("Google", { exact: true })).toBeVisible();
    await expect(card.getByText("GitHub", { exact: true })).toBeVisible();
    await expect(card.getByText("Redirect URI to register in Google Cloud Console")).toBeVisible();
    await expect(card.getByText(/\/api\/auth\/google\/callback/)).toBeVisible();
    await expect(card.getByRole("button", { name: "Save", exact: true })).toBeVisible();

    const config = await api<{ bootstrap: boolean; providers: Array<{ provider: string }> }>(
      "/api/auth/sign-in",
    );
    expect(config.bootstrap).toBe(false);
    expect(config.providers.map((p) => p.provider).sort()).toEqual([
      "github",
      "gitlab",
      "google",
      "oidc",
    ]);
  });
});
