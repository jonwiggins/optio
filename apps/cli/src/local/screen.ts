import headless from "@xterm/headless";

/**
 * A headless terminal emulator fed the same bytes as the PTY, so the daemon
 * can read what is actually on screen instead of guessing from the raw byte
 * stream.
 *
 * Why not strip ANSI from the ring? TUIs don't write text, they paint cells:
 * Claude Code repaints only the cells that changed, jumping around with
 * absolute cursor moves. Flattening that stream to text glues fragments from
 * different repaints together — "…/jonwi" + jump + "ns/optio/pull/607" reads
 * as a real URL for the wrong repo, and "#6" + jump + "07" becomes a bare
 * ref to issue #6. Only a screen model knows which characters were ever
 * adjacent.
 */

// `@xterm/headless` ships as CommonJS; under NodeNext the class hangs off the
// default export at runtime.
const { Terminal } = headless as unknown as { Terminal: typeof headless.Terminal };
type Terminal = InstanceType<typeof Terminal>;

export const SCREEN_SCROLLBACK_LINES = 2000;

export type ScreenBuffer = "normal" | "alternate";

export class ScreenModel {
  private readonly term: Terminal;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: SCREEN_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
  }

  /** Feed PTY output. Parsing is queued; use `flush()` before reading. */
  write(data: string | Uint8Array): void {
    this.term.write(data);
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
