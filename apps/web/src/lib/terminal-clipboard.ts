import type { Terminal } from "@xterm/xterm";

/**
 * Copying out of a web terminal, whatever the program in it does with the
 * mouse. A full-screen program that tracks the mouse (Claude Code's
 * fullscreen renderer, vim with `mouse=a`, htop) gets every drag, so the
 * terminal never selects anything itself. Two ways out, as in a desktop
 * terminal:
 *
 * - ⌥-drag (Shift-drag off a Mac) selects in the terminal anyway, and ⌘C
 *   copies it. xterm.js takes ⌥ for this only with
 *   `macOptionClickForcesSelection`.
 * - The program copies for you with OSC 52 (`ESC ] 52 ; c ; <base64> BEL`):
 *   Claude Code's copy-on-select and `/copy`, tmux, neovim. The text goes on
 *   this browser's clipboard as it arrives where the browser allows a write
 *   then (Chrome; Firefox shortly after a click), and on the next ⌘C with
 *   nothing selected here where it doesn't (Safari).
 *
 * Never from replayed output (reattaching would re-copy something from long
 * ago), and never the other way: a program asking to read the clipboard
 * (`52;c;?`) gets no answer.
 */

/** The most text a program can put on the clipboard (Claude Code caps its own at 1 MiB). */
export const OSC52_MAX_BYTES = 1024 * 1024;

/**
 * The text an OSC 52 write carries (`<selection>;<base64>`, the part after
 * `52;`). Null for a read request (`?`), a clear (no payload), bad base64,
 * or text over the limit.
 */
export function parseOsc52(data: string): string | null {
  const sep = data.indexOf(";");
  if (sep < 0) return null;
  // Some programs wrap long base64 across lines.
  const payload = data.slice(sep + 1).replace(/\s+/g, "");
  if (!payload || payload === "?") return null;
  if (payload.length > Math.ceil(OSC52_MAX_BYTES / 3) * 4) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const text = new TextDecoder().decode(bytes);
  return text || null;
}

/**
 * Give a terminal the copy behavior above. `container` is the element the
 * terminal opens into (⌘C and clicks are heard there); `replaying` says the
 * output being parsed is a replay. Returns a cleanup for the listeners.
 */
export function installTerminalClipboard(
  term: Terminal,
  container: HTMLElement,
  opts: { replaying?: () => boolean } = {},
): () => void {
  term.options.macOptionClickForcesSelection = true;

  // What the program last copied, for a ⌘C when the browser wouldn't take
  // it on arrival. A click here (the program's own selection goes with it)
  // or a keystroke forgets it.
  let copied: string | null = null;

  term.parser.registerOscHandler(52, (data) => {
    if (opts.replaying?.()) return true;
    const text = parseOsc52(data);
    if (text === null) return true;
    copied = text;
    navigator.clipboard?.writeText(text).catch(() => {
      // Not without a click (Safari), or the page isn't focused: ⌘C carries it.
    });
    return true;
  });

  const onCopy = (event: ClipboardEvent) => {
    // The terminal's own selection wins: xterm.js has already put it on the event.
    if (event.defaultPrevented || term.hasSelection() || copied === null) return;
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", copied);
    event.preventDefault();
  };
  const forget = () => {
    copied = null;
  };
  container.addEventListener("copy", onCopy);
  container.addEventListener("pointerdown", forget);
  const keys = term.onKey(forget);
  return () => {
    container.removeEventListener("copy", onCopy);
    container.removeEventListener("pointerdown", forget);
    keys.dispose();
  };
}
