import { expect, test } from "@playwright/test";
import { liveTerminal } from "./fake-daemon";
const API = "http://127.0.0.1:4931";

test("sharing explains control, supports revocation and keeps link tokens out of navigated URLs", async ({
  page,
  request,
}) => {
  const session = await liveTerminal(request, { title: "Collaborative session" });
  const me = await (await request.get(`${API}/api/auth/me`)).json();
  const owner = "11111111-1111-4111-8111-111111111111";
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { ...me, authDisabled: false, user: { ...me.user, id: owner } } }),
  );
  await page.route(`**/api/local/terminals/${session.id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, terminal: { ...body.terminal, userId: owner } } });
  });
  let revoked = false,
    redeemed = "";
  const token = "a".repeat(43),
    shareId = "22222222-2222-4222-8222-222222222222";
  await page.route(`**/api/session-shares/local/${session.id}`, (route) =>
    route.fulfill({
      json:
        route.request().method() === "GET"
          ? { shares: [] }
          : {
              id: shareId,
              path: `/shared-session#${token}`,
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
            },
    }),
  );
  await page.route(`**/api/session-shares/local/${session.id}/${shareId}`, (route) => {
    revoked = true;
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/session-shares/redeem", (route) => {
    redeemed = route.request().postDataJSON().token;
    return route.fulfill({ json: { kind: "local", targetId: session.id } });
  });
  try {
    await page.goto(`/local/${session.id}`);
    await page.getByRole("button", { name: "Share session", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Collaborate on this session" });
    await expect(dialog).toContainText("view and control");
    await expect(dialog).toContainText("run commands on your machine");
    await dialog.getByRole("button", { name: "Create collaboration link" }).click();
    await expect(dialog.getByLabel("Session sharing link")).toHaveValue(new RegExp(`#${token}$`));
    await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect.poll(() => revoked).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Share session", exact: true })).toBeFocused();
    await page.goto(`/shared-session#${token}`);
    await expect(page).toHaveURL(new RegExp(`/local/${session.id}$`));
    expect(redeemed).toBe(token);
    expect(
      await page.evaluate(() => sessionStorage.getItem("optio_pending_session_share")),
    ).toBeNull();
  } finally {
    await session.done();
  }
});

test("an offline machine exposes reconnecting status while preserving its session", async ({
  page,
  request,
}) => {
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const laptop = hosts.find((h: { name: string }) => h.name === "E2E laptop");
  const response = await request.post(`${API}/api/local/terminals`, {
    data: {
      hostId: laptop.id,
      dir: "/Users/e2e/notes",
      title: "Recovery status",
      spec: { kind: "shell" },
    },
  });
  const { terminal } = await response.json();
  try {
    await page.goto(`/local/${terminal.id}`);
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting." })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Reconnecting." })).toContainText(
      /Waiting/,
    );
  } finally {
    await request.delete(`${API}/api/local/terminals/${terminal.id}`);
  }
});
