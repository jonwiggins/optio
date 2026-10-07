/**
 * The Work list has a way into the session screen (`/local/:id`, the
 * terminal with every session in its rail): the Sessions button, which opens
 * on the session that most needs you.
 */
import { expect, test } from "@playwright/test";
import { liveTerminal } from "./fake-daemon";

const API = "http://127.0.0.1:4931";

// Headless Chromium normally hides native scrollbars. These interaction tests
// need the real thumb visible and draggable, as it is in the user's browser.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

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

test("the session sidebar resizes, remembers its width and keeps the mobile drawer", async ({
  page,
  request,
}) => {
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const laptop = hosts.find((h: { name: string }) => h.name === "E2E laptop");
  const created = await request.post(`${API}/api/local/terminals`, {
    data: {
      hostId: laptop.id,
      dir: "/Users/e2e/notes",
      title: "Resize sidebar",
      spec: { kind: "shell" },
    },
  });
  expect(created.ok()).toBe(true);
  const { terminal } = await created.json();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/local/${terminal.id}`);
    const rail = page.getByRole("complementary", { name: "Session sidebar" });
    const handle = page.getByRole("separator", { name: "Resize session sidebar" });
    await expect(handle).toBeVisible();
    await expect(rail).toHaveCSS("width", "240px");
    const dragTo = async (x: number) => {
      const box = (await handle.boundingBox())!;
      const start = box.x + box.width - 1;
      const currentWidth = (await rail.boundingBox())!.width;
      await page.mouse.move(start, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(start + x - currentWidth, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
    };
    await dragTo(360);
    await expect(rail).toHaveCSS("width", "360px");
    await page.reload();
    await expect(rail).toHaveCSS("width", "360px");
    await dragTo(800);
    await expect(rail).toHaveCSS("width", "440px");
    await dragTo(80);
    await expect(rail).toHaveCSS("width", "200px");
    await expect(page.locator("body")).not.toHaveCSS("user-select", "none");

    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(rail).toHaveCSS("width", "216px");
    await page.keyboard.press("End");
    await expect(rail).toHaveCSS("width", "440px");
    await page.setViewportSize({ width: 800, height: 900 });
    await expect(rail).toHaveCSS("width", "360px");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(rail).toHaveCSS("width", "440px");
    await page.keyboard.press("Control+Shift+b");
    await expect(rail).toBeHidden();
    await page.keyboard.press("Control+Shift+b");
    await expect(rail).toBeVisible();
    await expect(rail).toHaveCSS("width", "440px");
    await handle.dblclick({ position: { x: (await handle.boundingBox())!.width - 1, y: 12 } });
    await expect(rail).toHaveCSS("width", "240px");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await expect(rail).toHaveCSS("width", "240px");
    await expect(page.getByRole("searchbox", { name: "Search sessions" })).toBeVisible();
    await expect(handle).toBeHidden();
  } finally {
    await request.delete(`${API}/api/local/terminals/${terminal.id}`);
  }
});

test("the session scrollbar and resize handle have independent drag targets", async ({
  page,
  request,
}) => {
  const { hosts } = await (await request.get(`${API}/api/local/hosts`)).json();
  const laptop = hosts.find((h: { name: string }) => h.name === "E2E laptop");
  const ids: string[] = [];
  try {
    for (let i = 0; i < 12; i++) {
      const created = await request.post(`${API}/api/local/terminals`, {
        data: {
          hostId: laptop.id,
          dir: "/Users/e2e/notes",
          title: `Scroll session ${i + 1}`,
          spec: { kind: "shell" },
        },
      });
      expect(created.ok()).toBe(true);
      ids.push((await created.json()).terminal.id);
    }
    await page.setViewportSize({ width: 1280, height: 620 });
    await page.goto(`/local/${ids.at(-1)}`);
    const rail = page.getByRole("complementary", { name: "Session sidebar" });
    const list = rail.getByRole("region", { name: "Sessions", exact: true });
    const handle = rail.getByRole("separator", { name: "Resize session sidebar" });
    const search = page.getByRole("searchbox", { name: "Search sessions" });
    await expect(list.getByRole("button", { name: /^Scroll session 1 / })).toBeAttached();
    await expect(rail).toHaveCSS("width", "240px");
    const headerY = (await search.boundingBox())!.y;
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    const metrics = await list.evaluate((el) => ({
      height: el.clientHeight,
      content: el.scrollHeight,
      gutter: el.offsetWidth - el.clientWidth,
    }));
    expect(metrics.content).toBeGreaterThan(metrics.height);
    expect(metrics.gutter).toBe(0);
    const box = (await list.boundingBox())!;
    const activeRow = list.locator('[aria-current="page"]');
    const rowBox = (await activeRow.boundingBox())!;
    const leftInset = rowBox.x - box.x;
    const rightInset = box.x + box.width - (rowBox.x + rowBox.width);
    expect(leftInset).toBe(6);
    expect(rightInset).toBe(leftInset);
    await expect(activeRow).toHaveCSS("border-top-right-radius", "12px");
    const scrollbar = rail.getByRole("scrollbar", { name: "Scroll sessions" });
    const scrollBox = (await scrollbar.boundingBox())!;
    const resizeBox = (await handle.boundingBox())!;
    const railBox = (await rail.boundingBox())!;
    expect(resizeBox.x + resizeBox.width).toBeLessThanOrEqual(railBox.x + railBox.width);
    expect(scrollBox.x + scrollBox.width).toBeLessThanOrEqual(resizeBox.x + resizeBox.width - 2);
    expect(scrollBox.x).toBeLessThan(rowBox.x + rowBox.width);

    // The overlay thumb scrolls the native viewport without catching the resizer.
    const thumb = (await scrollbar.locator("[data-session-scroll-thumb]").boundingBox())!;
    expect(box.x + box.width - (thumb.x + thumb.width)).toBe(2);
    const thumbX = thumb.x + thumb.width / 2;
    const thumbY = thumb.y + thumb.height / 2;
    // Overlapping hit boxes resolve to the scroll overlay, then the outer
    // resize edge. Neither reaches over the terminal's first character.
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest('[role="scrollbar"]')
            ?.getAttribute("aria-label"),
        { x: thumbX, y: thumbY },
      ),
    ).toBe("Scroll sessions");
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest('[role="separator"]')
            ?.getAttribute("aria-label"),
        { x: resizeBox.x + resizeBox.width - 1, y: thumbY },
      ),
    ).toBe("Resize session sidebar");
    await page.mouse.move(thumbX, thumbY);
    await page.mouse.down();
    await page.mouse.move(thumbX, thumbY + 120, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    await expect(rail).toHaveCSS("width", "240px");
    expect((await search.boundingBox())!.y).toBe(headerY);

    await scrollbar.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
    await page.mouse.move(thumbX, thumbY);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press("End");
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop + el.clientHeight))
      .toBe(metrics.content);
    await list.focus();
    await page.keyboard.press("Home");
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 150);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await expect(rail).toHaveCSS("width", "256px");
    // Filtering removes the scrollable content without shifting the rows.
    const listWidth = (await list.boundingBox())!.width;
    await search.fill("Scroll session 12");
    await expect(list.locator("[data-terminal-id]")).toHaveCount(1);
    expect((await list.boundingBox())!.width).toBe(listWidth);
    expect(await list.evaluate((el) => el.offsetWidth - el.clientWidth)).toBe(metrics.gutter);
    await expect(scrollbar).toHaveCount(0);
    await page.screenshot({ path: "/tmp/optio-session-balanced-sidebar.png" });
  } finally {
    for (const id of ids) await request.delete(`${API}/api/local/terminals/${id}`);
  }
});

test("terminal history scrolls inside the session without an extra page scrollbar", async ({
  page,
  request,
}) => {
  const terminal = await liveTerminal(request, {
    title: "Session scrolling",
    screen: "$ ready\r\n",
  });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/local/${terminal.id}`);
    const viewport = page.locator(".local-xterm .xterm-viewport");
    await expect(viewport).toBeVisible();
    await expect.poll(() => terminal.resizes.length).toBeGreaterThan(0);
    const gutter = () => viewport.evaluate((el) => el.offsetWidth - el.clientWidth);
    const pageOverflow = () =>
      page.evaluate(() => {
        const main = document.querySelector("main")!;
        return {
          document: document.documentElement.scrollHeight - document.documentElement.clientHeight,
          page: main.scrollHeight - main.clientHeight,
          horizontal: main.scrollWidth - main.clientWidth,
          offset: main.scrollTop,
        };
      });
    // No scrollbar for a fresh terminal with no history to scroll through.
    await expect.poll(gutter).toBe(0);
    const headerY = (await page.getByRole("textbox", { name: "Session title" }).boundingBox())!.y;
    terminal.output(Array.from({ length: 120 }, (_, i) => `Output line ${i}\r\n`).join(""));
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const bottom = await viewport.evaluate((el) => el.scrollTop);
    await page.locator(".local-xterm").hover();
    await page.mouse.wheel(0, -300);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThan(bottom);
    await expect.poll(pageOverflow).toEqual({ document: 0, page: 0, horizontal: 0, offset: 0 });
    expect((await page.getByRole("textbox", { name: "Session title" }).boundingBox())!.y).toBe(
      headerY,
    );

    // Full-screen TUIs use the alternate buffer, which has no scrollback.
    terminal.output("\x1b[?1049h\x1b[2J\x1b[HFull-screen session");
    for (const size of [
      { width: 1000, height: 500 },
      { width: 390, height: 700 },
    ]) {
      await page.setViewportSize(size);
      await expect.poll(gutter).toBe(0);
      await expect.poll(pageOverflow).toEqual({ document: 0, page: 0, horizontal: 0, offset: 0 });
    }
  } finally {
    await terminal.done();
  }
});
