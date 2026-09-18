import type { LocalStats } from "./types.js";

/**
 * Pure helpers for the overview's Local section. Kept DOM-free so the
 * roll-up and the "is this section quiet?" rules are unit-testable.
 */

const LIVE = new Set(["pending", "launching", "running"]);
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isLiveTerminal(t: any): boolean {
  return LIVE.has(t.state);
}

export function computeLocalStats(terminals: any[], hosts: any[]): LocalStats {
  const live = terminals.filter(isLiveTerminal);
  return {
    total: terminals.length,
    needsYou: terminals.filter((t) => t.attentionState === "needs_you").length,
    working: live.filter((t) => t.attentionState === "working").length,
    idle: live.filter((t) => t.attentionState !== "working" && t.attentionState !== "needs_you")
      .length,
    finished: terminals.filter((t) => t.state === "exited" || t.state === "error").length,
    hosts: hosts.length,
    hostsOnline: hosts.filter((h) => h.state === "online").length,
  };
}

function activityTime(t: any): number {
  return new Date(t.lastActivityAt ?? t.updatedAt ?? t.createdAt ?? 0).getTime();
}

/**
 * What the overview shows: everything live, plus anything that finished in
 * the last 24 h. Needs-you first (longest wait on top), then by recency.
 */
export function recentLocalTerminals(terminals: any[], now = Date.now(), max = 6): any[] {
  const since = now - RECENT_WINDOW_MS;
  return terminals
    .filter((t) => isLiveTerminal(t) || activityTime(t) >= since)
    .sort((a, b) => {
      const an = a.attentionState === "needs_you" ? 0 : 1;
      const bn = b.attentionState === "needs_you" ? 0 : 1;
      if (an !== bn) return an - bn;
      // Among needs-you: the one you've kept waiting longest first.
      return an === 0 ? activityTime(a) - activityTime(b) : activityTime(b) - activityTime(a);
    })
    .slice(0, max);
}

/**
 * A concept section is "quiet" when nothing in it is live or waiting —
 * the overview folds quiet sections into one summary line so the page is
 * only as tall as what's actually happening.
 */
export function isLocalQuiet(stats: LocalStats | null, recent: any[]): boolean {
  if (!stats) return true;
  return stats.needsYou === 0 && stats.working === 0 && stats.idle === 0 && recent.length === 0;
}
