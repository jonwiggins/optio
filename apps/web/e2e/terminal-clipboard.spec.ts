/**
 * Copy and paste in a Local terminal, including over a program that tracks
 * the mouse. Claude Code's fullscreen renderer takes every drag and copies
 * the text itself with OSC 52; the terminal puts that on the clipboard
 * (never from the replay, and never answering a program that asks to read
 * it), and ⌥-drag still selects in the terminal. See lib/terminal-clipboard.ts.
 *
 * The browser claims to be a Mac (so this holds on Linux CI too). A copy is
 * checked on the ClipboardEvent the browser fires for ⌘C, which is where
 * the page decides what gets copied; on a Mac host a real ⌘C runs too.
 */
import { expect, test, type Page } from "@playwright/test";
import { liveTerminal } from "./fake-daemon";

const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text, "utf-8").toString("base64")}\x07`;
// What Claude Code turns on in fullscreen: the alternate screen, mouse
// tracking (press / drag / any motion, SGR reports), and bracketed paste.
const FULLSCREEN = "\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?2004h";

const asMac = (page: Page) =>
  page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
  });

/** Fire the ClipboardEvent ⌘C fires, at the focused terminal; what it carries is what's copied. */
const copy = (page: Page) =>
  page.evaluate(() => {
    const data = new DataTransfer();
    const event = new ClipboardEvent("copy", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    document.querySelector(".xterm-helper-textarea")!.dispatchEvent(event);
    return data.getData("text/plain");
  });

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

async function open(page: Page, id: string, first: string) {
  await page.goto(`/local/${id}`);
  const rows = page.locator(".xterm-rows > div");
  await expect(rows.first()).toContainText(first, { timeout: 30_000 });
  return rows;
}

test("what a program copies reaches the clipboard, but not from the replay", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // The replay opens with a copy made long ago.
  const terminal = await liveTerminal(request, {
    title: "osc52",
    screen: `${osc52("from the replay")}ready\r\n`,
  });
  try {
    await asMac(page);
    await page.goto("/");
    await page.evaluate(() => navigator.clipboard.writeText("before"));
    const rows = await open(page, terminal.id, "ready");
    await rows.first().click();
    // The replay's copy never lands, and a program asking to read the
    // clipboard gets nothing back.
    terminal.output(`\x1b]52;c;?\x07asked\r\n`);
    await expect(rows.nth(1)).toContainText("asked");
    await page.waitForTimeout(500);
    expect(await clipboard(page)).toBe("before");
    expect(terminal.input.join("")).not.toContain("]52");

    // A live copy (Claude Code's copy-on-select) lands straight away.
    terminal.output(osc52("npm test -- --watch"));
    await expect.poll(() => clipboard(page)).toBe("npm test -- --watch");
  } finally {
    await terminal.done();
  }
});

test("⌥-drag selects over a program that tracks the mouse; ⌘C copies it", async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const terminal = await liveTerminal(request, {
    title: "select",
    screen: `${FULLSCREEN}alpha bravo charlie\r\n`,
  });
  try {
    await asMac(page);
    const rows = await open(page, terminal.id, "alpha bravo charlie");
    const box = (await rows.first().boundingBox())!;
    const y = box.y + box.height / 2;
    const drag = async () => {
      await page.mouse.move(box.x + 1, y);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, y, { steps: 4 });
      await page.mouse.move(box.x + 400, y, { steps: 4 });
      await page.mouse.up();
    };

    // A plain drag is the program's: it gets mouse reports, the terminal selects nothing.
    await drag();
    await expect.poll(() => terminal.input.join("")).toContain("\x1b[<0;");
    expect(await copy(page)).toBe("");

    // ⌥-drag selects in the terminal, and the program hears no press, drag
    // or release of it (bare pointer motion it still gets: it tracks that).
    terminal.input.length = 0;
    await page.keyboard.down("Alt");
    await drag();
    await page.keyboard.up("Alt");
    expect(await copy(page)).toBe("alpha bravo charlie");
    expect(terminal.input.join("")).not.toMatch(/\x1b\[<(?:0|8|32|40);\d+;\d+[Mm]/);

    // The real key, where the browser runs on a Mac (Playwright maps ⌘C to
    // the copy command there only).
    if (process.platform === "darwin") {
      await page.keyboard.press("Meta+c");
      await expect.poll(() => clipboard(page)).toBe("alpha bravo charlie");
    }
  } finally {
    await terminal.done();
  }
});

test("⌘C carries the program's copy where the browser won't take it on arrival", async ({
  page,
  request,
}) => {
  const terminal = await liveTerminal(request, {
    title: "safari",
    screen: `${FULLSCREEN}logs\r\n`,
  });
  try {
    await asMac(page);
    // Safari: no clipboard write without a click in the same moment.
    await page.addInitScript(() => {
      navigator.clipboard.writeText = () => Promise.reject(new DOMException("", "NotAllowedError"));
    });
    const rows = await open(page, terminal.id, "logs");
    await rows.first().click();
    terminal.output(osc52("Error: connect ECONNREFUSED 127.0.0.1:5432"));
    await expect.poll(() => copy(page)).toBe("Error: connect ECONNREFUSED 127.0.0.1:5432");

    // A click clears the program's selection, and with it what ⌘C would copy.
    await rows.first().click();
    expect(await copy(page)).toBe("");
  } finally {
    await terminal.done();
  }
});

test("a paste reaches the program, bracketed when it asked", async ({ page, request }) => {
  const terminal = await liveTerminal(request, {
    title: "paste",
    screen: `${FULLSCREEN}prompt\r\n`,
  });
  try {
    await asMac(page);
    const rows = await open(page, terminal.id, "prompt");
    await rows.first().click();
    terminal.input.length = 0;
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "echo pasted\nsecond line");
      const event = new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      document.querySelector(".xterm-helper-textarea")!.dispatchEvent(event);
    });
    await expect
      .poll(() => terminal.input.join(""))
      .toContain("\x1b[200~echo pasted\rsecond line\x1b[201~");
  } finally {
    await terminal.done();
  }
});
