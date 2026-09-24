/**
 * Links in a session open on ⌘-click, straight away in a new tab, with no
 * "Do you want to navigate to…?" prompt (xterm.js's default for OSC 8
 * hyperlinks, which Claude Code and gh print). A plain click is just a
 * click in the terminal. See lib/terminal-links.ts.
 */
import { expect, test } from "@playwright/test";
import { liveTerminal } from "./fake-daemon";

// Row 1: an OSC 8 hyperlink (what `gh pr create` prints); row 2: a bare URL.
const SCREEN =
  "\x1b]8;;https://github.com/acme/app/pull/7\x07acme/app#7\x1b]8;;\x07\r\n" +
  "https://github.com/acme/app/pull/8\r\n";

test("links in a session open on ⌘-click, with no prompt", async ({ page, context, request }) => {
  const terminal = await liveTerminal(request, { title: "links", screen: SCREEN });
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  // A test never leaves for github.com.
  await context.route("https://github.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "ok" }),
  );
  try {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
    });
    await page.goto(`/local/${terminal.id}`);
    const rows = page.locator(".xterm-rows > div");
    await expect(rows.first()).toContainText("acme/app#7", { timeout: 30_000 });
    const onRow = async (row: number) => {
      const box = (await rows.nth(row).boundingBox())!;
      return { x: box.x + 12, y: box.y + box.height / 2 };
    };
    const cmdClick = async (at: { x: number; y: number }) => {
      await page.mouse.move(at.x, at.y);
      await page.keyboard.down("Meta");
      await page.mouse.click(at.x, at.y);
      await page.keyboard.up("Meta");
    };

    // A plain click is a click in the terminal: no prompt, nothing opens.
    const hyperlink = await onRow(0);
    await page.mouse.move(hyperlink.x, hyperlink.y);
    await page.mouse.click(hyperlink.x, hyperlink.y);
    await page.waitForTimeout(500);
    expect(dialogs).toEqual([]);
    expect(context.pages()).toHaveLength(1);

    // ⌘-click opens the hyperlink's target in a new tab, straight away.
    const opened = context.waitForEvent("page");
    await cmdClick(hyperlink);
    const tab = await opened;
    await expect.poll(() => tab.url()).toContain("github.com/acme/app/pull/7");
    await tab.close();

    // The same for a URL printed as plain text.
    const openedUrl = context.waitForEvent("page");
    await cmdClick(await onRow(1));
    const urlTab = await openedUrl;
    await expect.poll(() => urlTab.url()).toContain("github.com/acme/app/pull/8");
    await urlTab.close();

    expect(dialogs).toEqual([]);
  } finally {
    await terminal.done();
  }
});
