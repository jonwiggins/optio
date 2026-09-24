import type { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";

/**
 * How links in a terminal open: ⌘-click (Ctrl-click off a Mac) opens one in a
 * new tab straight away, the way iTerm and VS Code's terminal do. A plain
 * click stays a click in the terminal (focus, selection, the agent's own
 * mouse handling), and nothing asks "Do you want to navigate to…?" — the
 * confirm xterm.js shows by default for OSC 8 hyperlinks, which is how Claude
 * Code and gh print their PR links. A touch screen has no ⌘, so a tap opens.
 */

const isMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const isTouchOnly = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(hover: none)").matches;

/** Whether a click on a link asked to open it. */
export function isOpenLinkClick(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  opts: { mac?: boolean; touchOnly?: boolean } = {},
): boolean {
  if (opts.touchOnly ?? isTouchOnly()) return true;
  return (opts.mac ?? isMac()) ? event.metaKey : event.ctrlKey;
}

/** Open a clicked link in a new tab — web links only, whatever scheme a hyperlink names. */
export function openTerminalLink(event: MouseEvent, uri: string): void {
  if (!isOpenLinkClick(event) || !/^https?:\/\//i.test(uri)) return;
  window.open(uri, "_blank", "noopener,noreferrer");
}

/**
 * Give a terminal its link behavior: OSC 8 hyperlinks (`linkHandler`) and
 * URLs found in the text (the web-links addon) both open on ⌘-click, and
 * hovering one says so.
 */
export function installTerminalLinks(term: Terminal): void {
  const hint = isTouchOnly() ? "" : isMac() ? "⌘-click to open" : "Ctrl-click to open";
  const hover = (_event: MouseEvent, uri: string) => {
    if (hint && term.element) term.element.title = `${hint} ${uri}`;
  };
  const leave = () => term.element?.removeAttribute("title");
  term.options.linkHandler = { activate: openTerminalLink, hover, leave };
  term.loadAddon(new WebLinksAddon(openTerminalLink, { hover, leave }));
}
