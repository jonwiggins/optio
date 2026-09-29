/**
 * What a viewer gets when it attaches to a running session: the terminal as
 * it stands, drawn for the PTY's grid (a daemon with a screen model sends a
 * serialized snapshot and names its grid; the relay puts a `replay` frame in
 * front of it).
 *
 * - The program's modes arrive with it. Claude Code's fullscreen UI turns on
 *   the alternate screen and SGR mouse reporting once, at startup; a replay
 *   without them left the wheel scrolling nothing.
 * - It is laid out at the grid it was drawn for before this screen sizes it.
 *   Written at a narrower width first, a full-width rule wrapped onto a second
 *   row and stayed broken (the alternate screen doesn't reflow).
 */
import { expect, test, type Page } from "@playwright/test";
import { liveTerminal } from "./fake-daemon";

/** The text of each rendered terminal row (the DOM renderer draws one div per row). */
async function rows(page: Page): Promise<string[]> {
  return page
    .locator(".local-xterm .xterm-rows > div")
    .evaluateAll((divs) => divs.map((d) => (d.textContent ?? "").replace(/\u00a0/g, " ")));
}

test("the wheel reaches a program that turned on mouse reporting before this viewer attached", async ({
  page,
  request,
}) => {
  // A fullscreen program's state as a snapshot carries it: modes first, then its screen.
  const terminal = await liveTerminal(request, {
    title: "replay-modes",
    snapshotGrid: true,
    screen: "\x1b[?1049h\x1b[H> transcript line 1\r\n> transcript line 2\x1b[?1002h\x1b[?1006h",
  });
  try {
    await page.goto(`/local/${terminal.id}`);
    const screen = page.locator(".local-xterm .xterm-screen");
    await screen.waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await rows(page)).join("\n")).toContain("transcript line 2");
    const box = (await screen.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, -200);
        return terminal.input.join("");
      })
      .toMatch(/\x1b\[<64;\d+;\d+M/);
  } finally {
    await terminal.done();
  }
});

test("a viewer narrower than the session's grid lays the replay out at that grid", async ({
  browser,
  request,
}) => {
  // A full-width rule on the first row of a fullscreen program, drawn for the PTY's grid.
  const terminal = await liveTerminal(request, {
    title: "replay-grid",
    snapshotGrid: true,
    screen: ({ cols }) => `\x1b[?1049h\x1b[1;1H${"─".repeat(cols)}\x1b[2;1Hbelow the rule`,
  });
  // Separate windows: two tabs of one window would leave the first hidden, and a
  // hidden screen gives up the grid (rightly).
  const wideContext = await browser.newContext({ viewport: { width: 1700, height: 900 } });
  const narrowContext = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const wide = await wideContext.newPage();
  const narrow = await narrowContext.newPage();
  try {
    // The wide screen opens it first and, in use, keeps the grid.
    await wide.goto(`/local/${terminal.id}`);
    await wide.locator(".local-xterm .xterm-screen").waitFor({ timeout: 30_000 });
    await expect.poll(() => terminal.resizes.at(-1)?.cols ?? 0).toBeGreaterThan(150);
    const grid = terminal.resizes.at(-1)!;
    await wide.mouse.move(400, 400);

    await narrow.goto(`/local/${terminal.id}`);
    await expect(narrow.getByText("Sized for another device")).toBeVisible({ timeout: 30_000 });
    // Scaled down, but one rule on one row, and the next row intact.
    await expect
      .poll(async () => {
        const [first, second] = await rows(narrow);
        return [first?.trimEnd(), second?.trimEnd()];
      })
      .toEqual(["─".repeat(grid.cols), "below the rule"]);
  } finally {
    await wideContext.close();
    await narrowContext.close();
    await terminal.done();
  }
});

test("a screen that takes the grid parses the replay at the grid it was drawn for, then fits it", async ({
  browser,
  request,
}) => {
  // Drawn for the PTY's 120 columns; this screen fits far fewer, and takes the grid.
  const terminal = await liveTerminal(request, {
    title: "replay-owner",
    snapshotGrid: true,
    screen: ({ cols }) => `\x1b[?1049h\x1b[1;1H${"─".repeat(cols)}\x1b[2;1Hbelow the rule`,
  });
  const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
  try {
    await page.goto(`/local/${terminal.id}`);
    await page.locator(".local-xterm .xterm-screen").waitFor({ timeout: 30_000 });
    await expect.poll(() => terminal.resizes.at(-1)?.cols ?? 999).toBeLessThan(120);
    // Parsed at this screen's width first, the rule would have wrapped under
    // the second row's text and stayed there (the alternate screen doesn't reflow).
    await expect
      .poll(async () => (await rows(page)).slice(0, 3).map((r) => r.trimEnd()))
      .toEqual([expect.stringMatching(/^─+$/), "below the rule", ""]);
  } finally {
    await page.close();
    await terminal.done();
  }
});
