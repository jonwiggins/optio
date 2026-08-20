import type { LocalTerminalState } from "@optio/shared";

/**
 * Reconnect policy for the local terminal stream WS
 * (/ws/local/terminals/:id/stream). Pure so it can be unit-tested apart from
 * xterm/WebSocket plumbing.
 *
 * Close codes the server uses:
 * - 4401 — WS authentication failed
 * - 4403 — not authorized for this terminal / missing role
 * - 4429 — per-IP connection limit
 * - 4503 — host (daemon) disconnected: transient, the daemon reconnects
 * - 1000/1005 — deliberate close (ours on unmount, or the server's after a
 *   fatal error frame like "Terminal not found")
 */

/** Close codes that no amount of retrying can fix, with a user-facing line. */
export const PERMANENT_CLOSE_MESSAGES: Record<number, string> = {
  4401: "Authentication failed — sign in again and reload.",
  4403: "You don't have permission to view this terminal.",
  4429: "Too many connections — close other Optio tabs and reload.",
};

export type StreamCloseAction = { kind: "reconnect" } | { kind: "stop"; message: string | null };

/**
 * Decide what to do when the stream socket closes (the component already
 * bails before this on unmount).
 *
 * - Permanent rejections (auth/role/limit) stop with a message.
 * - A terminal that has exited/errored stops silently: nothing more will
 *   stream, and reconnecting would only risk wiping the history on screen.
 * - `retryRequested` marks a close we initiated to recover from a retryable
 *   error frame (e.g. "Host is offline"), so its 1000 must still reconnect.
 * - Other normal closes (1000/1005) are deliberate — don't loop on them.
 * - Everything else (4503 host blip, 1001 going away, 1006 abnormal) retries.
 */
export function closeAction(opts: {
  code: number;
  terminalDead: boolean;
  retryRequested: boolean;
}): StreamCloseAction {
  const permanent = PERMANENT_CLOSE_MESSAGES[opts.code];
  if (permanent) return { kind: "stop", message: permanent };
  if (opts.terminalDead) return { kind: "stop", message: null };
  if (opts.retryRequested) return { kind: "reconnect" };
  if (opts.code === 1000 || opts.code === 1005) return { kind: "stop", message: null };
  return { kind: "reconnect" };
}

/** States after which no further bytes will ever stream. */
export function isTerminalStateDead(state: LocalTerminalState): boolean {
  return state === "exited" || state === "error";
}
