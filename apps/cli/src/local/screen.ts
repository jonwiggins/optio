import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";

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
 */

// `@xterm/headless` and the serialize addon ship as CommonJS; under NodeNext
// the classes hang off the default export at runtime.
const { Terminal } = headless as unknown as { Terminal: typeof headless.Terminal };
type Terminal = InstanceType<typeof Terminal>;
const { SerializeAddon } = serialize as unknown as {
  SerializeAddon: typeof serialize.SerializeAddon;
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

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: SCREEN_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.term.loadAddon(this.serializer);
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
   * for SGR reports; without it a wheel sends X10 bytes it ignores) and a
   * hidden cursor.
   */
  private extraModes(): string {
    const core = (this.term as any)._core;
    let out = "";
    const encoding = core?.coreMouseService?.activeEncoding;
    if (encoding === "SGR") out += "\x1b[?1006h";
    else if (encoding === "SGR_PIXELS") out += "\x1b[?1016h";
    if (core?.coreService?.isCursorHidden) out += "\x1b[?25l";
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
