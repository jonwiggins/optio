/**
 * Model providers end to end: add a Bedrock provider in Settings, pick it
 * in the New work form (the model list swaps to the provider's), and read
 * the saved Job back for `agentOptions.modelProvider`, its model, the owner,
 * and the picked pod secrets. Needs the backend's /api/model-providers.
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

const stamp = Date.now().toString(36);
const providerName = `E2E Bedrock ${stamp}`;

test.describe("Model providers", () => {
  test("Settings adds a provider; the work form picks it for a Job", async ({ page }) => {
    await page.goto("/settings");
    const section = page.locator("#model-providers");
    await expect(section).toBeVisible({ timeout: 30_000 });
    await section.getByRole("button", { name: "Add provider" }).click();
    const nameField = section.locator("input").first();
    await nameField.fill(providerName);
    await section.getByRole("button", { name: "IAM role", exact: true }).click();
    await section.getByRole("button", { name: "Add provider" }).last().click();
    await expect(section.getByText(providerName)).toBeVisible();

    const { providers } = await api<{ providers: any[] }>("/api/model-providers");
    const provider = providers.find((p) => p.name === providerName);
    expect(provider?.podCredential).toBe("ambient");
    expect(provider?.models["claude-code"]?.[0]?.id).toBe("us.anthropic.claude-opus-5-5");

    // A secret to pick.
    const secretName = `E2E_SECRET_${stamp.toUpperCase()}`;
    await api("/api/secrets", {
      method: "POST",
      body: JSON.stringify({ name: secretName, value: "x" }),
    });

    await page.goto("/work/new");
    await expect(page.getByRole("heading", { name: "New work" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Open a PR", exact: true }).click();
    await page.getByRole("button", { name: "No repo", exact: true }).click();
    const who = page.locator("#session-who");
    await who.getByRole("button", { name: providerName, exact: true }).click();
    await expect(who.locator("select").first()).toHaveValue("us.anthropic.claude-opus-5-5");
    await expect(who.locator("header")).toContainText(providerName);

    // Pod secrets live with the rest of the pod's environment, under Where.
    const where = page.locator("#session-where");
    await where.getByRole("button", { name: /^Environment/ }).click();
    await where.getByLabel("Add secret").selectOption(`workspace:${secretName}`);
    await expect(where.getByText(secretName)).toBeVisible();

    await page.locator("#session-prompt textarea").fill("Say hello");
    await page.locator("#session-name input").first().fill(`E2E provider job ${stamp}`);
    await page.locator('form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]{36}\/runs\/[0-9a-f-]{36}$/, {
      timeout: 30_000,
    });
    const [, jobId] = page.url().match(/\/jobs\/([0-9a-f-]{36})\//)!;
    const { workflow } = await api(`/api/jobs/${jobId}`);
    expect(workflow.agentOptions.modelProvider).toBe(provider.id);
    expect(workflow.agentOptions.claudeModel).toBe("us.anthropic.claude-opus-5-5");
    expect(workflow.ownerUserId ?? null).toBeNull();
    expect(workflow.podSecrets).toEqual([secretName]);
  });
});
