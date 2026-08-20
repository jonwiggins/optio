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

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "").replace(CONTROL_RE, "");
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
