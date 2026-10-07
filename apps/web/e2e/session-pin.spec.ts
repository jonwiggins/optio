import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, fakeDaemon } from "./fake-daemon";

/** Two live shells on ONE fake daemon (a second daemon for the same host would replace the first). */
async function twoLiveTerminals(request: APIRequestContext) {
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const laptop = hosts.find((h: { name: string }) => h.name === "E2E laptop");
  const daemon = await fakeDaemon(laptop.id, laptop.dirs, { screen: "$ ready\r\n" });
  const make = async (title: string) => {
    const created = await request.post(`${API}/api/local/terminals`, {
      data: { hostId: laptop.id, dir: "/Users/e2e/notes", title, spec: { kind: "shell" } },
    });
    expect(created.ok()).toBe(true);
    const { terminal } = await created.json();
    await expect
      .poll(async () => {
        const res = await request.get(`${API}/api/local/terminals/${terminal.id}`);
        return (await res.json()).terminal?.state;
      })
      .toBe("running");
    return terminal.id as string;
  };
  const older = await make("Older session");
  const newer = await make("Newer session");
  return {
    older,
    newer,
    async done() {
      try {
        for (const id of [older, newer]) {
          await request.post(`${API}/api/local/terminals/${id}/kill`).catch(() => {});
          await request.delete(`${API}/api/local/terminals/${id}`).catch(() => {});
        }
      } finally {
        daemon.close();
      }
    },
  };
}

test("a pinned session goes to the top of the rail and stays there until unpinned", async ({
  page,
  request,
}) => {
  const sessions = await twoLiveTerminals(request);
  const { older, newer } = sessions;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/local/${newer}`);
    const rows = page.locator("[data-terminal-id]");
    // Newest first until something is pinned.
    await expect(rows.first()).toHaveAttribute("data-terminal-id", newer);

    await page.locator(`[data-terminal-id="${older}"]`).hover();
    const pin = page.getByTestId(`session-pin-${older}`);
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    const pinned = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/local/terminals/${older}/pin`) && r.request().method() === "POST",
    );
    await pin.click();
    expect((await pinned).ok()).toBe(true);
    await expect(rows.first()).toHaveAttribute("data-terminal-id", older);
    await expect(pin).toHaveAttribute("aria-pressed", "true");

    // Kept on the server: a reload shows the same order.
    const row = (await (await request.get(`${API}/api/local/terminals/${older}`)).json()).terminal;
    expect(row.pinnedAt).toBeTruthy();
    await page.reload();
    await expect(page.locator("[data-terminal-id]").first()).toHaveAttribute(
      "data-terminal-id",
      older,
    );

    await page.locator(`[data-terminal-id="${older}"]`).hover();
    const unpinned = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/local/terminals/${older}/pin`) && r.request().method() === "DELETE",
    );
    await page.getByTestId(`session-pin-${older}`).click();
    expect((await unpinned).ok()).toBe(true);
    await expect(page.locator("[data-terminal-id]").first()).toHaveAttribute(
      "data-terminal-id",
      newer,
    );
  } finally {
    await sessions.done();
  }
});
