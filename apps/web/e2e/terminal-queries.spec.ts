/**
 * Who answers a program's queries. A Local terminal is one PTY with any number
 * of viewers, or none: `optio local up` answers the program's queries itself
 * from its screen model (cursor position, device attributes, colors — Codex
 * draws no composer band without its background color) and says so in its
 * hello. A viewer then stays quiet, or every tab and phone watching would type
 * its own answer into the program. An older daemon doesn't answer, and the
 * viewer answers live queries as before (terminal-sizing.spec.ts).
 */
import { expect, test, type Page } from "@playwright/test";
import { liveTerminal } from "./fake-daemon";

// What a TUI asks as it starts: the cursor position, the foreground and
// background colors, the device attributes.
const QUERIES = "\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[c";

/** Record the frames the page sends on its WebSockets. */
async function recordSent(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const sent: string[] = ((window as any).__sent = []);
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      sent.push(String(data));
      return send.call(this, data);
    };
  });
  return () => page.evaluate(() => (window as any).__sent as string[]);
}

const inputs = (frames: string[]) =>
  frames
    .map((f) => {
      try {
        return JSON.parse(f);
      } catch {
        return null;
      }
    })
    .filter((m) => m?.type === "input")
    .map((m) => m.data as string);

const replies = (data: string[]) => data.filter((d) => /\x1b\[\??[\d;]*[Rc]|\x1b\]1[01];/.test(d));

test("a viewer leaves the answers to a daemon that gives them", async ({ page, request }) => {
  const terminal = await liveTerminal(request, {
    title: "queries",
    screen: `$ ready\r\n${QUERIES}`,
    answersQueries: true,
  });
  try {
    const sent = await recordSent(page);
    await page.goto(`/local/${terminal.id}`);
    const rows = page.locator(".xterm-rows > div");
    await expect(rows.first()).toContainText("ready", { timeout: 30_000 });
    await rows.first().click();
    // Live queries too: the daemon answered them already.
    terminal.output(`live\r\n${QUERIES}`);
    await expect(rows.nth(1)).toContainText("live");
    await page.keyboard.type("x");
    await expect.poll(async () => inputs(await sent())).toContain("x");
    expect(replies(inputs(await sent()))).toEqual([]);
    expect(replies(terminal.input)).toEqual([]);
    expect(terminal.input).toContain("x");
  } finally {
    await terminal.done();
  }
});

test("an older daemon gets the viewer's answers to live queries", async ({ page, request }) => {
  const terminal = await liveTerminal(request, { title: "queries-old", screen: "$ ready\r\n" });
  try {
    await page.goto(`/local/${terminal.id}`);
    const rows = page.locator(".xterm-rows > div");
    await expect(rows.first()).toContainText("ready", { timeout: 30_000 });
    await page.waitForTimeout(500);
    terminal.output(QUERIES);
    await expect.poll(() => replies(terminal.input).length).toBeGreaterThanOrEqual(2);
    expect(terminal.input.join("")).toContain("\x1b]11;rgb:0909/0909/0b0b");
  } finally {
    await terminal.done();
  }
});
