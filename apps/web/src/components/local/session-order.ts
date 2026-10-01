/**
 * The order of every session navigation list (the session rail, the /work
 * list's terminal rows). Stable on purpose: a session moves only when YOU
 * type into it (`lastInteractedAt`, stamped server-side) or when it ends —
 * never because its attention state flipped between "working" and "needs
 * you", which used to make rows jump out from under the pointer.
 *
 *   order = lastInteractedAt ?? createdAt, newest first; tie → createdAt; tie → id
 *
 * Attention shows on the row (dot, pulse, "needs you" line), and the header
 * count + "next needs you" shortcut are how you find waiting sessions.
 */

export interface OrderedSessions<T> {
  /** running / launching / pending (and anything not yet ended). */
  live: T[];
  /** exited / error. */
  finished: T[];
}

function ms(v: unknown): number {
  if (typeof v !== "string" || !v) return 0;
  const n = Date.parse(v);
  return Number.isNaN(n) ? 0 : n;
}

/** The time a session sorts by: when you last typed into it, else when it was made. */
export function sessionOrderTime(t: any): number {
  return ms(t.lastInteractedAt) || ms(t.createdAt);
}

export function compareSessions(a: any, b: any): number {
  return (
    sessionOrderTime(b) - sessionOrderTime(a) ||
    ms(b.createdAt) - ms(a.createdAt) ||
    String(a.id ?? "").localeCompare(String(b.id ?? ""))
  );
}

export function isFinishedSession(t: any): boolean {
  return t.state === "exited" || t.state === "error";
}

export function orderSessions<T>(terminals: T[]): OrderedSessions<T> {
  const sorted = [...terminals].sort(compareSessions);
  return {
    live: sorted.filter((t) => !isFinishedSession(t)),
    finished: sorted.filter((t) => isFinishedSession(t)),
  };
}

/** The visual order: live sessions, then finished. */
export function sessionOrder<T>(terminals: T[]): T[] {
  const { live, finished } = orderSessions(terminals);
  return [...live, ...finished];
}

/**
 * The next session waiting on you after `activeId` in visual order
 * (wrapping), or the first one when none is active. Null when nothing waits
 * or the only waiting session is the active one.
 */
export function nextNeedsYou<T extends { id: string; attentionState?: string | null }>(
  ordered: T[],
  activeId: string | null,
): T | null {
  const waiting = ordered.filter((t) => t.attentionState === "needs_you");
  if (waiting.length === 0) return null;
  const idx = activeId ? ordered.findIndex((t) => t.id === activeId) : -1;
  for (let i = 1; i <= ordered.length; i++) {
    const t = ordered[(idx + i + ordered.length) % ordered.length];
    if (t.attentionState === "needs_you") return t.id === activeId ? null : t;
  }
  return null;
}
