import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { TERMINAL_THEME } from "@optio/shared";

/**
 * Fonts with the box-drawing and block characters agent TUIs draw with,
 * before the browser's generic `monospace` (Courier in Safari, which has
 * none of them and borrows each from another font at another width).
 */
export const TERMINAL_FONT_FAMILY =
  "'JetBrains Mono', 'Fira Code', Menlo, Monaco, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";

/**
 * A terminal set up the way every Optio terminal is: the shared theme (the
 * colors the daemon reports to programs that ask), Unicode 11 character
 * widths (an emoji is two cells, as the program laid it out and as the
 * daemon's screen model counts), and bold that stays bold rather than
 * turning a color bright.
 */
export function createTerminal(options: ITerminalOptions = {}): Terminal {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: TERMINAL_FONT_FAMILY,
    theme: { ...TERMINAL_THEME },
    drawBoldTextInBrightColors: false,
    // The Unicode API is still "proposed" in xterm.js 5.
    allowProposedApi: true,
    ...options,
  });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  return term;
}

/**
 * Keep this terminal from answering the program's queries while `silent()`
 * says the machine answers them itself (`answersQueries`): the daemon's
 * screen model already did, once, whoever is watching. Covers everything
 * xterm.js answers: device status and cursor position (DSR / CPR), device
 * attributes (DA1 / DA2), modes (DECRQM), settings (DECRQSS), and color
 * queries (OSC 4 / 10 / 11 / 12 with `?`; setting a color still applies).
 */
export function silenceQueryReplies(term: Terminal, silent: () => boolean): () => void {
  const parser = term.parser;
  const swallow = () => silent();
  const disposables = [
    parser.registerCsiHandler({ final: "n" }, swallow),
    parser.registerCsiHandler({ prefix: "?", final: "n" }, swallow),
    parser.registerCsiHandler({ final: "c" }, swallow),
    parser.registerCsiHandler({ prefix: ">", final: "c" }, swallow),
    parser.registerCsiHandler({ intermediates: "$", final: "p" }, swallow),
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, swallow),
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, swallow),
    ...[4, 10, 11, 12].map((ident) =>
      parser.registerOscHandler(ident, (data) => silent() && data.split(";").includes("?")),
    ),
  ];
  return () => {
    for (const d of disposables) d.dispose();
  };
}
