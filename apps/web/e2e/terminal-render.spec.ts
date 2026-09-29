/**
 * How a Local terminal draws what Codex draws around its prompt: the composer
 * as a tinted band (rows erased with a background colour) and `────` rules
 * between turns. xterm's DOM renderer draws box-drawing glyphs with the font
 * and each row's background as its own box, so at fractional zoom the band
 * showed seams between its rows and a rule a tick at every glyph join — the
 * lines "broke". The terminal draws with WebGL where the browser has it.
 *
 * The e2e stack pins the DOM renderer (other specs read its rows); this spec
 * turns WebGL back on the way a person can turn it off, through localStorage,
 * and checks the pixels at 125% zoom. The zoom is real (a browser launched with
 * a device scale factor), not Playwright's emulation: WebGL sizes its canvas
 * from the element's device-pixel box, which emulation doesn't scale, so an
 * emulated 1.25x draws off the canvas.
 */
import { chromium, expect, test, type Page } from "@playwright/test";
import { liveTerminal } from "./fake-daemon";

const TINT = [38, 38, 40];

/** Rows 3–5 tinted the way Codex tints its composer, a rule on row 8. */
const codexPrompt = (cols: number) =>
  "\x1b[2J\x1b[H" +
  "\x1b[3;1H\x1b[48;2;38;38;40m\x1b[K" +
  "\x1b[4;1H\x1b[K› ask Codex" +
  "\x1b[5;1H\x1b[K\x1b[0m" +
  `\x1b[8;1H${"─".repeat(cols)}` +
  "\x1b[10;1H";

/** Pixel checks, run in the page on its own screenshot of the terminal. */
async function inspect(page: Page, cols: number, rows: number) {
  const screen = page.locator(".local-xterm .xterm-screen");
  const box = (await screen.boundingBox())!;
  const png = await page.screenshot({ clip: box, scale: "device" });
  return page.evaluate(
    async ({ b64, cols, rows, tint }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
      const at = (x: number, y: number) => {
        const i = (y * width + x) * 4;
        return [data[i]!, data[i + 1]!, data[i + 2]!];
      };
      const cellW = width / cols;
      const cellH = height / rows;
      const near = (c: number[], t: number[], d: number) =>
        c.every((v, i) => Math.abs(v - t[i]!) <= d);
      // Band: rows 3–5 (screen rows 2–4). Every pixel row inside it, away from
      // its top and bottom edges and the prompt's text, should be the tint.
      const top = Math.ceil(2 * cellH) + 1;
      const bottom = Math.floor(5 * cellH) - 2;
      const textEnd = Math.ceil(14 * cellW);
      const seams: number[] = [];
      for (let y = top; y <= bottom; y++) {
        let off = 0;
        for (let x = textEnd; x < width - 2; x++) if (!near(at(x, y), tint, 6)) off++;
        if (off > (width - textEnd) * 0.02) seams.push(y);
      }
      // Rule: row 8 (screen row 7). Its brightest pixel row, bright all along.
      let lineY = -1;
      let best = -1;
      for (let y = Math.floor(7 * cellH); y < Math.ceil(8 * cellH); y++) {
        let sum = 0;
        for (let x = 0; x < width; x += 3) sum += at(x, y)[0]!;
        if (sum > best) {
          best = sum;
          lineY = y;
        }
      }
      const lum = [] as number[];
      for (let x = Math.ceil(cellW); x < width - Math.ceil(cellW); x++) lum.push(at(x, lineY)[0]!);
      const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
      const ticks = lum.filter((v) => Math.abs(v - mean) > 24).length;
      const hasCanvas = !!document.querySelector(".local-xterm .xterm-screen canvas");
      return { seams, ticks, mean, hasCanvas, cellH, cellW };
    },
    { b64: png.toString("base64"), cols, rows, tint: TINT },
  );
}

test("Codex's prompt band and rules draw unbroken with WebGL at fractional zoom", async ({
  request,
  baseURL,
}) => {
  const terminal = await liveTerminal(request, { title: "render-webgl" });
  // 125%: the DOM renderer showed seams at the band's row boundaries here, and
  // ticks along the rule.
  const browser = await chromium.launch({
    args: ["--force-device-scale-factor=1.25", "--window-size=1100,700"],
  });
  // No viewport emulation: the window's own size and scale. (The test runner
  // would otherwise hand this context its project's emulated device.)
  const context = await browser.newContext({
    viewport: null,
    deviceScaleFactor: undefined,
    isMobile: undefined,
    hasTouch: undefined,
    baseURL,
  });
  await context.addInitScript(() => localStorage.setItem("optio.terminal.renderer", "webgl"));
  const page = await context.newPage();
  try {
    await page.goto(`/local/${terminal.id}`);
    await page.locator(".local-xterm .xterm-screen").waitFor({ timeout: 30_000 });
    // The screen takes the grid; once it has, draw what Codex draws there.
    await expect.poll(() => terminal.resizes.length).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const grid = terminal.resizes.at(-1)!;
    terminal.output(codexPrompt(grid.cols));
    const first = await inspect(page, grid.cols, grid.rows);
    test.skip(!first.hasCanvas, "no WebGL in this browser: the DOM renderer drew instead");
    // Polled: the canvas draws a frame or two after the output lands.
    await expect
      .poll(async () => {
        const { seams, ticks } = await inspect(page, grid.cols, grid.rows);
        return { seams, ticks };
      })
      .toEqual({ seams: [], ticks: 0 });
  } finally {
    await browser.close();
    await terminal.done();
  }
});
