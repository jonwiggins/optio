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

  describe("snapshot", () => {
    const replay = async (bytes: Buffer, cols = 80, rows = 24) => {
      const fresh = new ScreenModel(cols, rows);
      fresh.write(bytes);
      await fresh.flush();
      return fresh;
    };

    it("rebuilds a full-screen program with the modes it set long ago", async () => {
      // Claude Code's fullscreen UI: alternate screen, SGR mouse reporting, hidden
      // cursor — set once, then megabytes of repaints.
      const s = new ScreenModel(80, 24);
      s.write("$ claude\r\n\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?25l");
      for (let i = 0; i < 4000; i++)
        s.write(`\x1b[${(i % 20) + 1};1H\x1b[2Kline ${i} ${"·".repeat(60)}`);
      await s.flush();
      const bytes = s.snapshot(512 * 1024);
      const text = bytes.toString("utf-8");
      for (const mode of ["?1049h", "?1002h", "?1006h", "?2004h", "?25l"]) {
        expect(text).toContain(`\x1b[${mode}`);
      }
      const copy = await replay(bytes);
      expect(copy.activeBuffer).toBe("alternate");
      expect(copy.lines("alternate")).toEqual(s.lines("alternate"));
      expect(copy.lines("normal")).toEqual(["$ claude"]);
    });

    it("keeps an inline program's colored rows and scrollback", async () => {
      const s = new ScreenModel(40, 6);
      for (let i = 0; i < 20; i++) s.write(`history ${i}\r\n`);
      // A tinted band, drawn the way Codex draws its composer: erase with a background.
      s.write("\x1b[5;1H\x1b[48;2;38;38;40m\x1b[K\x1b[6;1H\x1b[K› ask\x1b[0m\x1b[6;3H");
      await s.flush();
      const copy = await replay(s.snapshot(512 * 1024), 40, 6);
      expect(copy.lines("normal")).toEqual(s.lines("normal"));
    });

    it("includes output written but not parsed yet", async () => {
      const s = new ScreenModel(80, 24);
      s.write("parsed\r\n");
      await s.flush();
      s.write("not yet");
      const copy = await replay(s.snapshot(512 * 1024));
      expect(copy.lines()).toEqual(["parsed", "not yet"]);
    });

    it("drops scrollback to fit the byte budget", async () => {
      const s = new ScreenModel(80, 24);
      for (let i = 0; i < 1500; i++) s.write(`row ${i} ${"x".repeat(70)}\r\n`);
      await s.flush();
      const small = s.snapshot(40 * 1024);
      expect(small.length).toBeLessThanOrEqual(40 * 1024);
      const copy = await replay(small);
      expect(copy.lines().at(-1)).toBe(s.lines().at(-1));
    });
  });
});

describe("ScreenModel answers the program's queries", () => {
  async function answers(data: string, cols = 80, rows = 24): Promise<string> {
    const replies: string[] = [];
    const screen = new ScreenModel(cols, rows, (r) => replies.push(r));
    screen.write(data);
    await screen.flush();
    screen.dispose();
    return replies.join("");
  }

  it("answers what Codex asks as it starts, in order", async () => {
    // Codex: cursor position, foreground, background, then device attributes
    // as the sentinel. Without the background it draws no composer band.
    expect(await answers("\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[c")).toBe(
      "\x1b[1;1R" +
        "\x1b]10;rgb:fafa/fafa/fafa\x1b\\" +
        "\x1b]11;rgb:0909/0909/0b0b\x1b\\" +
        "\x1b[?1;2c",
    );
  });

  it("reports where the cursor is on this grid", async () => {
    expect(await answers("\x1b[5;12H\x1b[6n", 100, 40)).toBe("\x1b[5;12R");
  });

  it("answers palette queries and colors the program set", async () => {
    expect(await answers("\x1b]4;1;?\x07")).toBe("\x1b]4;1;rgb:efef/4444/4444\x1b\\");
    expect(await answers("\x1b]4;196;?;232;?\x07")).toBe(
      "\x1b]4;196;rgb:ffff/0000/0000\x1b\\\x1b]4;232;rgb:0808/0808/0808\x1b\\",
    );
    expect(await answers("\x1b]11;#ffffff\x07\x1b]11;?\x07")).toBe(
      "\x1b]11;rgb:ffff/ffff/ffff\x1b\\",
    );
    expect(await answers("\x1b]11;rgb:ff/ff/ff\x07\x1b]111\x07\x1b]11;?\x07")).toBe(
      "\x1b]11;rgb:0909/0909/0b0b\x1b\\",
    );
    // `10;?;?` asks for the foreground and the background at once.
    expect(await answers("\x1b]10;?;?\x07")).toBe(
      "\x1b]10;rgb:fafa/fafa/fafa\x1b\\\x1b]11;rgb:0909/0909/0b0b\x1b\\",
    );
  });

  it("answers nothing for plain output", async () => {
    expect(await answers("hello \x1b[31mred\x1b[0m\r\n")).toBe("");
  });

  it("keeps a color the program set in the snapshot", async () => {
    const screen = new ScreenModel(80, 24, () => {});
    screen.write("\x1b]11;#102030\x07hi");
    await screen.flush();
    expect(screen.snapshot(64 * 1024).toString("utf-8")).toContain(
      "\x1b]11;rgb:1010/2020/3030\x1b\\",
    );
    screen.dispose();
  });

  it("measures emoji as two cells, as the program does", async () => {
    // Unicode 11 widths: the cursor lands after ✅ at column 3, not 2.
    expect(await answers("✅\x1b[6n")).toBe("\x1b[1;3R");
  });
});
