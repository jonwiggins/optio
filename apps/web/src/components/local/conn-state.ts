/**
 * Stream connection state shared by the xterm viewer and the pane chrome.
 * Kept out of local-terminal.tsx so chrome can import it without pulling
 * xterm (browser-only) into a server render.
 */
export type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected";

export const CONN_LABEL: Record<ConnState, string> = {
  connecting: "connecting…",
  connected: "connected",
  reconnecting: "reconnecting…",
  disconnected: "disconnected",
};

export const CONN_DOT: Record<ConnState, string> = {
  connecting: "bg-text-muted/40",
  connected: "bg-success",
  reconnecting: "bg-warning",
  disconnected: "bg-error",
};

/**
 * What Shift+Enter sends. xterm.js collapses every Enter to CR, so an agent
 * REPL can't tell Shift+Enter (newline) from Enter (submit). ESC CR is what
 * `claude /terminal-setup` teaches iTerm2 / VS Code to send for Shift+Enter,
 * and Claude Code reads it as "insert newline".
 */
export const SHIFT_ENTER_SEQUENCE = "\x1b\r";

/**
 * True for the bare Shift+Enter keydown. Ctrl/⌘+Shift+Enter is the rail's
 * "jump to needs you" chord and must fall through untouched.
 */
export function isShiftEnter(e: {
  type: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    e.type === "keydown" && e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
  );
}
