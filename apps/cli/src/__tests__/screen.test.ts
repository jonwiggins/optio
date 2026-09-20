import { describe, it, expect } from "vitest";
import { extractWorkLinks } from "@optio/shared";
import { ScreenModel } from "../local/screen.js";

async function screenWith(data: string, cols = 80, rows = 24): Promise<ScreenModel> {
  const screen = new ScreenModel(cols, rows);
  screen.write(data);
  await screen.flush();
  return screen;
}

describe("ScreenModel", () => {
  it("reads text as it sits on screen, not as it arrived", async () => {
    // A cell-diffed repaint: the URL is drawn, then a later frame overwrites a
    // few cells elsewhere with an absolute cursor move. In the byte stream the
    // two runs are adjacent; on screen they never were.
    const s = await screenWith(
      "https://github.com/jonwiggins/optio/pull/607\r\nsecond line\x1b[2;8Hxyz",
    );
    expect(s.lines()).toEqual(["https://github.com/jonwiggins/optio/pull/607", "second xyze"]);
    const urls = extractWorkLinks(s.allText()).map((l) => l.url);
    expect(urls).toEqual(["https://github.com/jonwiggins/optio/pull/607"]);
  });

  it("never yields a truncated bare ref from a fragmented repaint", async () => {
    // "#6" + jump + "07" is one cell run in the stream; on screen it is "#607".
    const s = await screenWith("see #6\x1b[1;7H07 done\r\n");
    expect(s.lines()[0]).toBe("see #607 done");
    const links = extractWorkLinks(s.allText(), {
      repoUrl: "https://github.com/jonwiggins/optio",
    });
    expect(links.map((l) => l.label)).toEqual(["#607"]);
  });

  it("heals soft wraps so a URL that ran past the right edge comes back whole", async () => {
    const s = await screenWith("opened https://github.com/jonwiggins/optio/pull/607 ok\r\n", 40);
    expect(s.lines()).toEqual(["opened https://github.com/jonwiggins/optio/pull/607 ok"]);
  });

  it("keeps hard line breaks (a TUI's own wrapping) for the scanner's heal pass", async () => {
    const s = await screenWith("https://github.com/jonwiggins/optio/pu\r\n  ll/607\r\n");
    expect(s.lines()).toEqual(["https://github.com/jonwiggins/optio/pu", "  ll/607"]);
    expect(extractWorkLinks(s.allText()).map((l) => l.url)).toEqual([
      "https://github.com/jonwiggins/optio/pull/607",
    ]);
  });

  it("includes both the normal buffer and an active alternate screen", async () => {
    const s = await screenWith(
      "$ git checkout -b fix/thing\r\n\x1b[?1049h\x1b[HOpened https://github.com/jonwiggins/optio/pull/608",
    );
    expect(s.activeBuffer).toBe("alternate");
    const text = s.allText();
    expect(text).toContain("git checkout -b fix/thing");
    expect(text).toContain("pull/608");
    expect(s.lines()).toEqual(["Opened https://github.com/jonwiggins/optio/pull/608"]);
  });

  it("keeps scrollback that left the viewport", async () => {
    const s = await screenWith(
      "first https://github.com/jonwiggins/optio/pull/1\r\n" + "x\r\n".repeat(30),
      80,
      5,
    );
    expect(s.lines()[0]).toBe("first https://github.com/jonwiggins/optio/pull/1");
  });
});
