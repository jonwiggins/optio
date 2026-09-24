/**
 * Keys reach a Local terminal the way a Mac terminal sends them. xterm.js
 * keys its Mac rules off navigator.platform, unless it believes it runs
 * under Node — which Next's `process` polyfill once made it believe (see
 * next.config.ts). Then ⌥↑ went out as Ctrl+↑, and Codex's "answer the
 * question" key never arrived.
 *
 * The browser claims to be a Mac (so this holds on Linux CI too). The test
 * plays the seeded laptop's daemon over the real protocol, so the bytes are
 * checked where a PTY would get them: browser → API relay → daemon.
 */
import { expect, test } from "@playwright/test";
import { liveTerminal } from "./fake-daemon";

test("Option+arrows reach a Local terminal as Alt+arrows on a Mac", async ({ page, request }) => {
  const terminal = await liveTerminal(request, { title: "keys" });
  try {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" });
    });
    await page.goto(`/local/${terminal.id}`);
    const keys = page.locator(".xterm-helper-textarea").first();
    await keys.waitFor({ state: "attached", timeout: 30_000 });
    // Typing reaches the daemon once the stream is up.
    await expect
      .poll(async () => {
        await keys.focus();
        await page.keyboard.type("x");
        return terminal.input.includes("x");
      })
      .toBe(true);
    terminal.input.length = 0;

    await page.keyboard.press("Alt+ArrowUp");
    await page.keyboard.press("Alt+ArrowDown");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect.poll(() => terminal.input.join("")).toBe("\x1b[1;3A\x1b[1;3B\x1b[1;2D");
  } finally {
    await terminal.done();
  }
});
