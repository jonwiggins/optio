/**
 * Preview builder for the wall view: ANSI-stripped tail of a terminal's
 * output, kept small enough to store in the DB (see docs/optio-local.md).
 */

export const PREVIEW_MAX_LINES = 12;
export const PREVIEW_MAX_CHARS = 2000;

// OSC/DCS/APC/PM strings (terminated by BEL or ESC \), CSI sequences,
// remaining two-byte ESC sequences.

const ANSI_RE =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b\[[0-9:;<=>?]*[ !"#$%&'()*+,\-./]*[@-~]|\x1b./g;

// Control characters other than \n, \r, \t.

const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// TUIs (Claude Code / Ink) lay text out with cursor moves instead of literal
// spaces and newlines: CHA (ESC [ n G, absolute column) between words, CUF
// (ESC [ n C, forward) for indents, CUD (ESC [ n B, down) for new lines.
// Dropping them glues words together, so flatten them first: CUF → spaces,
// CHA → pad to that column, CUD → newline. Column tracking resets on \r / \n.
const CURSOR_MOVE_RE = /\x1b\[(\d*)([GCB])|(\r|\n)|([^\x1b\r\n]+)/g;

export function flattenCursorMoves(text: string): string {
  let col = 0;
  return text.replace(CURSOR_MOVE_RE, (m, n: string, cmd: string, nl: string, run: string) => {
    if (nl !== undefined) {
      col = 0;
      return nl;
    }
    if (run !== undefined) {
      col += run.length;
      return run;
    }
    const count = Math.min(Math.max(parseInt(n || "1", 10) || 1, 1), 400);
    if (cmd === "C") {
      col += count;
      return " ".repeat(count);
    }
    if (cmd === "G") {
      const target = count - 1;
      const pad = Math.max(0, target - col);
      col = Math.max(col, target);
      return " ".repeat(pad);
    }
    // CUD keeps the column: the next word lands under the current one.
    return "\n".repeat(Math.min(count, 5)) + " ".repeat(col);
  });
}

export function stripAnsi(text: string): string {
  return flattenCursorMoves(text).replace(ANSI_RE, "").replace(CONTROL_RE, "");
}

/**
 * Build a preview from raw terminal output: strip ANSI, keep the last
 * PREVIEW_MAX_LINES non-empty lines, cap at PREVIEW_MAX_CHARS (keeping the
 * most recent characters).
 */
export function buildPreview(raw: string): string {
  const lines = stripAnsi(raw)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const tail = lines.slice(-PREVIEW_MAX_LINES).join("\n");
  return tail.length > PREVIEW_MAX_CHARS ? tail.slice(tail.length - PREVIEW_MAX_CHARS) : tail;
}
