/**
 * A session fits the screen you open it on, unless another screen showing it
 * is in use. Then the newcomer watches that screen's grid, scaled, with "Use
 * this screen", instead of yanking it away (services/local-grid.ts). Two
 * browser windows of different widths play the laptop and the phone; the
 * seeded laptop's fake daemon records every resize the PTY gets.
 *
 * The scrollback holds queries a TUI sends at startup (cursor position,
 * device attributes). xterm.js answers queries through the same channel as
 * keystrokes; answers to replayed ones must neither reach the program nor
 * count as typing, which would take the grid.
 */
import { expect, test, type Page } from "@playwright/test";
import { liveTerminal } from "./fake-daemon";

const strip = (page: Page) => page.getByText("Sized for another device");

/** The tab goes to the background, or comes back to the front. */
const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

test("a session fits the screen in use and waits for one that's busy", async ({
  browser,
  request,
}) => {
  const terminal = await liveTerminal(request, {
    title: "sizing",
    screen: "$ ready\r\n\x1b[6n\x1b[c",
  });
  const answers = () => terminal.input.filter((i) => /\x1b\[\??[\d;]*[Rc]/.test(i));
  const wide = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const narrow = await browser.newContext({ viewport: { width: 760, height: 900 } });
  const settled = async (page: Page) => {
    await expect(strip(page)).toBeHidden({ timeout: 30_000 });
    await page.waitForTimeout(500);
    return terminal.resizes.at(-1)!;
  };
  try {
    // The laptop opens the session: the PTY is fitted to it.
    const laptop = await wide.newPage();
    await laptop.goto(`/local/${terminal.id}`);
    await expect.poll(() => terminal.resizes.length, { timeout: 30_000 }).toBeGreaterThan(0);
    const laptopGrid = await settled(laptop);
    expect(answers()).toEqual([]);
    // A live query is answered.
    terminal.output("\x1b[6n");
    await expect.poll(answers).toHaveLength(1);

    // The phone opens it while the laptop is in use: it watches the laptop's grid.
    const phone = await narrow.newPage();
    const before = terminal.resizes.length;
    await phone.goto(`/local/${terminal.id}`);
    await expect(strip(phone)).toBeVisible({ timeout: 30_000 });
    await expect(phone.getByText(`${laptopGrid.cols}×${laptopGrid.rows}`)).toBeVisible();
    await phone.waitForTimeout(500);
    expect(terminal.resizes.length).toBe(before);
    // Answering a live query isn't typing: the watching phone keeps watching.
    terminal.output("\x1b[6n");
    await expect.poll(() => answers().length).toBeGreaterThan(1);
    await phone.waitForTimeout(500);
    await expect(strip(phone)).toBeVisible();
    expect(terminal.resizes.length).toBe(before);

    // "Use this screen" takes it; now the laptop watches.
    await phone.getByRole("button", { name: "Use this screen" }).click();
    const phoneGrid = await settled(phone);
    expect(phoneGrid.cols).toBeLessThan(laptopGrid.cols);
    await expect(strip(laptop)).toBeVisible();

    // The phone goes in a pocket; the laptop's tab comes back to the front: it's the laptop's again.
    await setVisibility(phone, "hidden");
    await setVisibility(laptop, "hidden");
    await setVisibility(laptop, "visible");
    expect(await settled(laptop)).toEqual(laptopGrid);

    // A screen that isn't showing the session never holds it up: with the
    // laptop's tab in the background, the phone's next arrival fits it at once.
    await setVisibility(laptop, "hidden");
    const again = await narrow.newPage();
    await again.goto(`/local/${terminal.id}`);
    await expect
      .poll(() => terminal.resizes.at(-1)!.cols, { timeout: 30_000 })
      .toBeLessThan(laptopGrid.cols);
    expect(await settled(again)).toEqual(phoneGrid);
    // The first phone window is the same size: it recognises its own grid, no strip.
    await expect(strip(phone)).toBeHidden();
  } finally {
    await wide.close();
    await narrow.close();
    await terminal.done();
  }
});
