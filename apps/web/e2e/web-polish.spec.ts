import { expect, test } from "@playwright/test";
import { API } from "./fake-daemon";

test("prompt dialog contains focus, preserves keyboard access, and search can be cleared", async ({
  page,
}) => {
  await page.goto("/templates");
  await expect(page.getByRole("heading", { name: "E2E seed prompt" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search prompts" }).fill("does-not-exist");
  await expect(page.getByRole("heading", { name: "No matching prompts" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "E2E seed prompt" })).toBeVisible();
  const opener = page.getByRole("button", { name: "New prompt", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "New prompt" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Unsaved draft");
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await opener.click();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(opener).toBeFocused();
});

test("settings navigation keeps an unsaved draft and reaches sections on narrow screens", async ({
  page,
}) => {
  await page.goto("/settings");
  const draft = page.getByPlaceholder(/Always use conventional commits/);
  await draft.fill("Keep this unsaved draft");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("link", { name: "Notifications", exact: true }).click();
  await expect(page).toHaveURL(/#notifications$/);
  await expect(page.getByRole("heading", { name: "Notifications", exact: true })).toBeInViewport();
  await nav.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(draft).toHaveValue("Keep this unsaved draft");
  await page.setViewportSize({ width: 390, height: 844 });
  await nav.getByRole("link", { name: "Access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Access", exact: true })).toBeInViewport();
  expect(await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
    true,
  );
});

test("session split resizes by keyboard, switches on mobile without reconnecting, and selects the chat model", async ({
  page,
  request,
}) => {
  const result = await request.post(`${API}/api/sessions`, {
    data: { repoUrl: "https://github.com/e2e/polish", title: "Responsive workspace" },
  });
  expect(result.ok()).toBe(true);
  const { session } = await result.json();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const frames: string[] = [];
  const sockets: string[] = [];
  page.on("websocket", (socket) => {
    sockets.push(socket.url());
    socket.on("framesent", ({ payload }) => frames.push(String(payload)));
  });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/sessions/${session.id}`);
    const resize = page.getByRole("separator", { name: "Resize chat and terminal" });
    await resize.focus();
    const before = Number(await resize.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowRight");
    await expect(resize).toHaveAttribute("aria-valuenow", String(before + 2));
    const model = page.getByRole("combobox", { name: "Chat model" });
    await expect(model).toBeVisible();
    const choices = await model
      .locator("option")
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLOptionElement).value));
    const next = choices.find((choice) => choice !== "sonnet") ?? choices[0];
    await model.selectOption(next);
    await expect
      .poll(() =>
        frames.some((frame) => {
          try {
            const v = JSON.parse(frame);
            return v.type === "set_model" && v.model === next;
          } catch {
            return false;
          }
        }),
      )
      .toBe(true);
    await expect(page.locator('[data-session-pane="pod-main"] .xterm')).toHaveCount(1);
    const terminalSockets = sockets.filter((url) => url.includes("/terminal")).length;
    await page.setViewportSize({ width: 390, height: 844 });
    const views = page.getByRole("group", { name: "Session view" });
    await expect(views).toBeVisible();
    await views.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.locator('[data-session-pane="pod-main"]')).toBeVisible();
    await views.getByRole("button", { name: "Agent Chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message the agent" })).toBeVisible();
    expect(sockets.filter((url) => url.includes("/terminal")).length).toBe(terminalSockets);
    expect(errors).toEqual([]);
    expect(
      await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.getByRole("button", { name: "End Session", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "End this session?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await request.post(`${API}/api/sessions/${session.id}/end`);
  }
});

for (const theme of ["dark", "light"]) {
  test(`library, reviews, inbox and detail pages fit a phone in ${theme} mode`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((value) => {
      localStorage.setItem("optio_theme", value);
    }, theme);
    for (const route of [
      "/templates",
      "/repos",
      "/connections",
      "/reviews",
      "/issues",
      "/machines",
      "/work?view=all",
    ]) {
      await page.goto(route);
      await expect(page.locator("main h1")).toBeVisible();
      await expect(page.getByText("Something went wrong")).toHaveCount(0);
      await expect
        .poll(() => page.locator("main").evaluate((node) => node.scrollWidth - node.clientWidth))
        .toBeLessThanOrEqual(1);
    }
    await page.getByText("E2E: opens a PR").first().click();
    await expect(page.getByText("Mock agent handled").first()).toBeVisible();
    expect(
      await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  });
}
