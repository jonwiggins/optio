import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import unicode11 from "@xterm/addon-unicode11";
import {
  TERMINAL_THEME,
  hexToRgb,
  terminalPaletteColor,
  xParseColor,
  type Rgb,
} from "@optio/shared";

/**
 * A headless terminal emulator fed the same bytes as the PTY, so the daemon
 * can read what is actually on screen instead of guessing from the raw byte
 * stream — and hand a viewer that attaches the terminal exactly as it is
 * (`snapshot`).
 *
 * Why not strip ANSI from the ring? TUIs don't write text, they paint cells:
 * Claude Code repaints only the cells that changed, jumping around with
 * absolute cursor moves. Flattening that stream to text glues fragments from
 * different repaints together — "…/jonwi" + jump + "ns/optio/pull/607" reads
 * as a real URL for the wrong repo, and "#6" + jump + "07" becomes a bare
 * ref to issue #6. Only a screen model knows which characters were ever
 * adjacent.
 *
 * It is also the terminal the program talks to: it answers the program's
 * queries (cursor position, device attributes, modes, colors) the way the
 * viewers' xterm.js would, through `reply`. A PTY has any number of viewers,
 * none while nobody watches — Codex asks for the background color as it
 * starts and draws no composer band without an answer — and several when a
 * tab and a phone watch, each of which would answer again. Like tmux, the
 * daemon answers once and the viewers stay quiet (see `answersQueries`).
 *
 * Character widths follow Unicode 11, as in the web viewer: an emoji takes
 * two cells, as in the program's own layout and in every modern terminal.
 */

// `@xterm/headless` and the serialize addon ship as CommonJS; under NodeNext
// the classes hang off the default export at runtime.
const { Terminal } = headless as unknown as { Terminal: typeof headless.Terminal };
type Terminal = InstanceType<typeof Terminal>;
const { SerializeAddon } = serialize as unknown as {
  SerializeAddon: typeof serialize.SerializeAddon;
};
const { Unicode11Addon } = unicode11 as unknown as {
  Unicode11Addon: typeof unicode11.Unicode11Addon;
};

/** The OSC color slots a program can query: 10 foreground, 11 background, 12 cursor. */
const DYNAMIC_COLORS: Record<number, string> = {
  10: TERMINAL_THEME.foreground,
  11: TERMINAL_THEME.background,
  12: TERMINAL_THEME.cursor,
};

export const SCREEN_SCROLLBACK_LINES = 2000;
/**
 * Scrollback lines a snapshot tries to carry, most first, until it fits the
 * byte budget (a web viewer keeps 1000 lines of scrollback).
 */
const SNAPSHOT_SCROLLBACK_STEPS = [1000, 250, 0];

export type ScreenBuffer = "normal" | "alternate";

export class ScreenModel {
  private readonly term: Terminal;
  private readonly serializer = new SerializeAddon();
  /** Output written but not parsed yet, oldest first (parsing is queued). */
  private unparsed: Buffer[] = [];
  private unparsedBytes = 0;

  /** Colors the program set (OSC 4 / 10 / 11 / 12), keyed `4:<index>` or the OSC number. */
  private readonly setColors = new Map<string, Rgb>();

  /**
   * `reply` receives the terminal's answers to the program's queries, in the
   * order they were asked (write them to the PTY). Without it, nothing is
   * answered.
   */
  constructor(cols: number, rows: number, reply?: (data: string) => void) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: SCREEN_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.term.loadAddon(this.serializer);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    if (reply) {
      // Cursor position, device status and attributes, modes, settings.
      this.term.onData(reply);
      this.answerColorQueries(reply);
    } else {
      // Nobody to answer: still keep a color query from reaching the
      // emulator's own handling.
      this.answerColorQueries(() => {});
    }
  }

  /**
   * OSC 4 / 10 / 11 / 12 queries (`?`): headless xterm has no theme and
   * leaves them unanswered, so answer from the viewers' theme, or what the
   * program itself set since. Same form as xterm.js (`rgb:rrrr/gggg/bbbb`,
   * ST-terminated).
   */
  private answerColorQueries(reply: (data: string) => void): void {
    const answer = (ident: string, key: string, fallback: Rgb) =>
      `\x1b]${ident};${xParseColor(this.setColors.get(key) ?? fallback)}\x1b\\`;

    // OSC 10 / 11 / 12 take a list: `11;?`, or `10;?;?` for 10 and 11 at once.
    for (const first of [10, 11, 12]) {
      this.term.parser.registerOscHandler(first, (data) => {
        const slots = data.split(";");
        let out = "";
        slots.forEach((spec, i) => {
          const ident = first + i;
          if (!(ident in DYNAMIC_COLORS)) return;
          if (spec === "?") {
            out += answer(String(ident), String(ident), hexToRgb(DYNAMIC_COLORS[ident]!));
          } else {
            const rgb = parseColorSpec(spec);
            if (rgb) this.setColors.set(String(ident), rgb);
          }
        });
        if (out) reply(out);
        return true;
      });
    }
    // OSC 110 / 111 / 112 restore the default.
    for (const ident of [110, 111, 112]) {
      this.term.parser.registerOscHandler(ident, () => {
        this.setColors.delete(String(ident - 100));
        return true;
      });
    }
    // OSC 4: `4;<index>;<spec>` pairs.
    this.term.parser.registerOscHandler(4, (data) => {
      const parts = data.split(";");
      let out = "";
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const index = Number(parts[i]);
        if (!Number.isInteger(index) || index < 0 || index > 255) continue;
        const key = `4:${index}`;
        if (parts[i + 1] === "?") {
          out += answer(`4;${index}`, key, terminalPaletteColor(index));
        } else {
          const rgb = parseColorSpec(parts[i + 1]!);
          if (rgb) this.setColors.set(key, rgb);
        }
      }
      if (out) reply(out);
      return true;
    });
    // OSC 104 restores palette entries (all of them without an index).
    this.term.parser.registerOscHandler(104, (data) => {
      if (!data) {
        for (const key of [...this.setColors.keys()]) {
          if (key.startsWith("4:")) this.setColors.delete(key);
        }
      } else {
        for (const index of data.split(";")) this.setColors.delete(`4:${index}`);
      }
      return true;
    });
  }

  /** Feed PTY output. Parsing is queued; use `flush()` before reading. */
  write(data: string | Uint8Array): void {
    const chunk = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
    this.unparsed.push(chunk);
    this.unparsedBytes += chunk.length;
    // Write callbacks run in order, one per chunk, as each is parsed.
    this.term.write(chunk, () => {
      const done = this.unparsed.shift();
      if (done) this.unparsedBytes -= done.length;
    });
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /**
   * The terminal as it stands, as bytes that rebuild it in a fresh emulator of
   * the same grid: scrollback, screen, the alternate screen when a full-screen
   * program is up, the cursor, and the modes the program set — mouse tracking
   * and its encoding, bracketed paste, a hidden cursor. Output not parsed yet
   * follows raw, so nothing written so far is missing.
   *
   * This is what a viewer that attaches gets instead of the tail of the raw
   * output: that tail lost the program's setup once the session had run long
   * enough (Claude Code turns on the alternate screen and mouse reporting once,
   * at startup — without them wheel and drag scroll nothing), started
   * mid-sequence, and replayed bytes drawn for whatever grid the PTY had at the
   * time.
   */
  snapshot(maxBytes: number): Buffer {
    const pending = this.pendingTail(maxBytes);
    let state = "";
    for (const scrollback of SNAPSHOT_SCROLLBACK_STEPS) {
      state = this.serializer.serialize({ scrollback }) + this.extraModes();
      if (Buffer.byteLength(state, "utf-8") + pending.length <= maxBytes) break;
    }
    return Buffer.concat([Buffer.from(state, "utf-8"), pending]);
  }

  /** The unparsed output, cut to its last `maxBytes` if a flood got that far ahead. */
  private pendingTail(maxBytes: number): Buffer {
    const all = Buffer.concat(this.unparsed, this.unparsedBytes);
    return all.length <= maxBytes / 2 ? all : all.subarray(all.length - Math.floor(maxBytes / 2));
  }

  /**
   * What the serialize addon leaves out: the mouse encoding (Claude Code asks
   * for SGR reports; without it a wheel sends X10 bytes it ignores), a
   * hidden cursor, and colors the program changed.
   */
  private extraModes(): string {
    const core = (this.term as any)._core;
    let out = "";
    const encoding = core?.coreMouseService?.activeEncoding;
    if (encoding === "SGR") out += "\x1b[?1006h";
    else if (encoding === "SGR_PIXELS") out += "\x1b[?1016h";
    if (core?.coreService?.isCursorHidden) out += "\x1b[?25l";
    // Colors the program set: the viewer's theme otherwise.
    for (const [key, rgb] of this.setColors) {
      const ident = key.startsWith("4:") ? `4;${key.slice(2)}` : key;
      out += `\x1b]${ident};${xParseColor(rgb)}\x1b\\`;
    }
    return out;
  }

  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
  }

  /** Resolves once every byte written so far has been parsed into the buffer. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.term.write("", resolve));
  }

  get activeBuffer(): ScreenBuffer {
    return this.term.buffer.active.type;
  }

  /**
   * Lines of a buffer as plain text, oldest first. Soft-wrapped continuations
   * are joined back onto their line (the emulator remembers the wrap), so a
   * URL that ran past the right edge comes back whole. Trailing blank lines
   * are dropped.
   */
  lines(which: ScreenBuffer = this.activeBuffer): string[] {
    const buf = which === "normal" ? this.term.buffer.normal : this.term.buffer.alternate;
    const out: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
      else out.push(text);
    }
    while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
    return out;
  }

  /**
   * Everything the model holds: the normal buffer (shell history + scrollback)
   * and, while a full-screen program is up, the alternate screen too — a
   * `claude` session prints its PR link on the alt screen, the shell that
   * launched it printed the branch on the normal one.
   */
  allText(): string {
    const parts = [this.lines("normal").join("\n")];
    if (this.activeBuffer === "alternate") parts.push(this.lines("alternate").join("\n"));
    return parts.join("\n");
  }

  dispose(): void {
    this.term.dispose();
  }
}

/** An X11 color spec a program sets a color with: `rgb:r/g/b` (1–4 hex digits each) or `#rgb` / `#rrggbb`. */
export function parseColorSpec(spec: string): Rgb | null {
  const rgb = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(spec);
  if (rgb) {
    const scale = (h: string) => Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255);
    return [scale(rgb[1]!), scale(rgb[2]!), scale(rgb[3]!)];
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(spec);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    return hexToRgb(`#${h}`);
  }
  return null;
}
