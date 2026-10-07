/**
 * What every Optio terminal agrees on: its colors, and which bytes a viewer
 * sends are the emulator answering a program's query rather than someone
 * typing.
 *
 * An Optio Local terminal is one PTY with any number of viewers (browser tabs,
 * phones) or none at all. The daemon answers the programs' queries itself from
 * its own screen model, as tmux does (see apps/cli/src/local/screen.ts), so a
 * program gets exactly one answer however many screens are watching —
 * including none: Codex asks for the background color at startup and draws no
 * composer band without an answer.
 */

/** The terminal's colors: the web viewer's theme, and what the daemon reports to OSC 4 / 10 / 11 / 12 queries. */
export const TERMINAL_THEME = {
  background: "#09090b",
  foreground: "#fafafa",
  cursor: "#ffffff",
  selectionBackground: "#6d28d944",
  // The 16 ANSI colors. Black stays visible on the background and white
  // stays apart from the foreground, so neither text nor a band in those
  // colors disappears.
  black: "#27272a",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#f59e0b",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#d4d4d8",
  brightBlack: "#71717a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#fafafa",
} as const;

export type Rgb = readonly [number, number, number];

const ANSI_ORDER = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** `#rrggbb` → [r, g, b]. */
export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** The theme's color for a 256-color palette index (the 6×6×6 cube and the grays past 15, as xterm draws them). */
export function terminalPaletteColor(index: number): Rgb {
  if (index < 16) return hexToRgb(TERMINAL_THEME[ANSI_ORDER[index]!]);
  if (index < 232) {
    const i = index - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return [level(Math.floor(i / 36)), level(Math.floor(i / 6) % 6), level(i % 6)];
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
}

/** The `rgb:rrrr/gggg/bbbb` form terminals answer color queries with. */
export function xParseColor(rgb: Rgb): string {
  const hex = (v: number) => v.toString(16).padStart(2, "0").repeat(2);
  return `rgb:${hex(rgb[0])}/${hex(rgb[1])}/${hex(rgb[2])}`;
}

/**
 * An emulator answering a query: a cursor position (CPR), a status or
 * color-scheme report (DSR), its identity (DA1 / DA2 / DA3, XTVERSION), a
 * mode or setting (DECRQM, DECRQSS), a window size (XTWINOPS), a color (OSC).
 */
const QUERY_REPLY = new RegExp(
  "^(?:" +
    [
      "\\x1b\\[[?>=]?[\\d;]*[Rnct]", // CPR / DECXCPR, DSR, DA1 / DA2, XTWINOPS
      "\\x1b\\[[?>=]?[\\d;]*\\$y", // DECRQM
      "\\x1b\\[\\?[\\d;]*u", // keyboard-protocol flags
      "\\x1b[P\\]][\\s\\S]*?(?:\\x07|\\x1b\\\\)", // DCS / OSC strings (DA3, XTVERSION, DECRQSS, colors)
    ].join("|") +
    ")+$",
);

/** F3 with a modifier (⇧F3, ⌃F3, …): the same bytes as a cursor position on row 1. A key, so never a reply. */
const MODIFIED_F3 = /^\x1b\[1;(?:[2-9]|1[0-6])R$/;

/** The emulator answering a program's query, never a keystroke. */
export function isTerminalQueryReply(data: string): boolean {
  return QUERY_REPLY.test(data) && !MODIFIED_F3.test(data);
}

/** Mouse reports (a program tracking the mouse) and focus in / out reports: the pointer, not typing. */
const POINTER_REPORT = new RegExp(
  "^(?:" +
    [
      "\\x1b\\[[IO]", // focus in / out
      "\\x1b\\[<\\d+;\\d+;\\d+[Mm]", // SGR mouse
      "\\x1b\\[\\d+;\\d+;\\d+M", // urxvt mouse
      "\\x1b\\[M[\\s\\S]{3}", // X10 / normal mouse
    ].join("|") +
    ")+$",
);

/** A mouse or focus report the emulator sends on its own — never a keystroke. */
export function isTerminalPointerReport(data: string): boolean {
  return POINTER_REPORT.test(data);
}

/**
 * Someone typing into the terminal, as opposed to what the emulator sends on
 * its own: answers to a program's queries, mouse reports, and the focus
 * report a click produces. Lists order sessions by the last typing, so
 * opening or clicking a session must not count.
 */
export function isTerminalTyping(data: string): boolean {
  return data.length > 0 && !isTerminalQueryReply(data) && !isTerminalPointerReport(data);
}
