import { expect, test } from "@playwright/test";
import { API, liveTerminal } from "./fake-daemon";

test("terminal here opens a shell in the same directory, groups locally and ungroups without killing", async ({
  page,
  request,
  context,
}) => {
  const session = await liveTerminal(request, {
    title: "Implementation session",
    screen: "$ ready\r\n",
  });
  const children: string[] = [];
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/local/${session.id}`);
    const created = page.waitForResponse(
      (r) => r.url().endsWith("/api/local/terminals") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Open terminal here", exact: true }).click();
    const response = await created;
    expect(response.ok()).toBe(true);
    const { terminal } = await response.json();
    children.push(terminal.id);
    expect(terminal.dir).toBe("/Users/e2e/notes");
    expect(terminal.spec.kind).toBe("shell");
    const original = (await (await request.get(`${API}/api/local/terminals/${session.id}`)).json())
      .terminal;
    expect(terminal.hostId).toBe(original.hostId);
    await expect(page).toHaveURL(new RegExp(`split=${terminal.id}`));
    const group = page.locator(`[data-session-group="${session.id}"]`);
    await expect(group.locator(`[data-terminal-id="${terminal.id}"]`)).toBeVisible();
    await expect(page.locator("[data-session-pane]")).toHaveCount(2);
    await expect(
      page.locator(`[data-session-pane="${terminal.id}"] .xterm-helper-textarea`),
    ).toHaveCount(1);
    await expect(
      page
        .locator(`[data-session-pane="${terminal.id}"]`)
        .getByRole("button", { name: "Open terminal here", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "/tmp/optio-session-panes-local.png" });
    const other = await context.newPage();
    await other.goto(`/local/${session.id}`);
    await expect(other.locator("[data-session-pane]")).toHaveCount(1);
    await expect(other.locator("[data-session-group]")).toHaveCount(0);
    await other.close();
    await group.getByRole("button", { name: `Ungroup ${terminal.title}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/local/${session.id}$`));
    const after = (await (await request.get(`${API}/api/local/terminals/${terminal.id}`)).json())
      .terminal;
    expect(after.state).toBe("running");
    // Existing sessions use the same nested presentation.
    await page
      .getByRole("button", { name: `Open ${terminal.title} side by side`, exact: true })
      .click();
    await expect(group.locator(`[data-terminal-id="${terminal.id}"]`)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("[data-session-pane]")).toHaveCount(2);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    for (const id of children) {
      await request.post(`${API}/api/local/terminals/${id}/kill`);
      await expect
        .poll(
          async () =>
            (await (await request.get(`${API}/api/local/terminals/${id}`)).json()).terminal.state,
        )
        .toBe("exited");
      await request.delete(`${API}/api/local/terminals/${id}`);
    }
    await session.done();
  }
});

test("pod terminal panes have their own streams and only group in the current view", async ({
  page,
  request,
  context,
}) => {
  const response = await request.post(`${API}/api/sessions`, {
    data: { repoUrl: "https://github.com/e2e/panes", title: "Pod workspace" },
  });
  expect(response.ok()).toBe(true);
  const { session } = await response.json();
  const streams: string[] = [];
  page.on("websocket", (ws) => streams.push(ws.url()));
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/sessions/${session.id}`);
    await page.getByTitle("Hide Terminal", { exact: true }).click();
    await page.getByRole("button", { name: "Open terminal here", exact: true }).click();
    await expect(page).toHaveURL(/terminals=1$/);
    await expect(page.locator('[data-session-pane="pod-1"]')).toBeVisible();
    await expect(
      page
        .locator(`[data-session-group="${session.id}"]`)
        .getByRole("button", { name: "Terminal 2", exact: true }),
    ).toBeVisible();
    await expect.poll(() => streams.some((url) => url.endsWith("/terminal?terminal=1"))).toBe(true);
    await page.screenshot({ path: "/tmp/optio-session-panes-pod.png" });
    const other = await context.newPage();
    await other.goto(`/sessions/${session.id}`);
    await expect(
      other.getByRole("button", { name: "Open terminal here", exact: true }),
    ).toBeVisible();
    await expect(other.locator('[data-session-pane="pod-1"]')).toHaveCount(0);
    await other.close();
    await page.getByRole("button", { name: "Open terminal here", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Open terminal here", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Ungroup terminal 2", exact: true }).click();
    await expect(page.locator('[data-session-pane="pod-1"]')).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Open terminal here", exact: true }),
    ).toBeEnabled();
  } finally {
    await request.post(`${API}/api/sessions/${session.id}/end`);
  }
});
