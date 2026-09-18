// gen-swift: skip-file
//
// Wire contract for the iOS "Watch" Live Activity (docs/design/ios-glanceable-
// surfaces.md §2a). The Swift side is hand-written in apps/ios/Shared/
// WatchActivity.swift (it needs ActivityKit conformances the generator can't
// emit), so this file is excluded from gen-swift — keep the field names in
// lockstep with that file by hand.
//
// Dates: ActivityKit decodes `content-state` with a default JSONDecoder, whose
// `Date` strategy is seconds since 2001-01-01T00:00:00Z (Foundation's
// reference date), NOT unix epoch or ISO-8601. Every date-valued field below is
// therefore a `number` in "Apple seconds"; use `appleSeconds()` to convert.

export type WatchPhase = "waiting" | "working" | "offline" | "done";

export type WatchItemKind = "local" | "task" | "agent";

/** One row in the Watch: a local terminal, a followed task, or an agent turn. */
export interface WatchItem {
  kind: WatchItemKind;
  id: string;
  /** Human title (terminal title, task title, agent name). */
  title: string;
  /** Monospace secondary: dir basename, branch, or agent slug. */
  mono: string;
  /** Short reason for attention, e.g. "Waiting on a permission". */
  reason?: string | null;
  /** Last non-empty output line, ≤120 chars; rendered privacySensitive on-device. */
  preview?: string | null;
  /** When the item entered its current state — Apple seconds. */
  since: number;
  /** Raw state string (`needs_you`, `running`, `pr_opened`, …). */
  state: string;
  /** Deep link, e.g. `optio://local/<id>?compose=1`. */
  link: string;
  /** Pull request URL for followed tasks in `pr_opened`. */
  prUrl?: string | null;
  /** Server-side "Later" window end — Apple seconds. */
  snoozedUntil?: number | null;
}

/** `WatchAttributes.ContentState` on the Swift side. */
export interface WatchState {
  phase: WatchPhase;
  /** Oldest item needing you (when `waiting`) or most recent running item (when `working`). */
  head?: WatchItem | null;
  /** Up to two further items needing you; the island only shows `head`. */
  others: WatchItem[];
  /** Total items needing you, including `head` and beyond `others`. */
  needsYouCount: number;
  runningCount: number;
  /** Apple seconds. */
  offlineSince?: number | null;
  summary?: string | null;
  /** When the state was computed — Apple seconds. */
  asOf: number;
}

/** `WatchAttributes` on the Swift side (fixed for the activity's lifetime). */
export interface WatchAttributes {
  userId: string;
  /** Apple seconds. */
  startedAt: number;
}

/** Milliseconds between the unix epoch and Foundation's reference date (2001-01-01). */
export const APPLE_REFERENCE_DATE_MS = 978_307_200_000;

/** Convert a date to Foundation "seconds since reference date" (whole seconds). */
export function appleSeconds(date: Date | string | number): number {
  const ms = typeof date === "number" ? date : new Date(date).getTime();
  return Math.round((ms - APPLE_REFERENCE_DATE_MS) / 1000);
}

/** Longest `preview` the Watch carries; keeps the payload far under APNs' 4 KB. */
export const WATCH_PREVIEW_MAX_CHARS = 120;

/** How many needs-you items ride along beside `head`. */
export const WATCH_OTHERS_MAX = 2;

export interface BuildWatchStateInput {
  /** Items needing you (any order; sorted oldest-first here). */
  needsYou: WatchItem[];
  /** Items currently working (any order; sorted newest-first here). */
  running: WatchItem[];
  /** Apple seconds when the host went unreachable, or null when everything is reachable. */
  offlineSince?: number | null;
  /** Wrap-up line for the `done` frame. */
  summary?: string | null;
  now?: Date;
}

function clampItem(item: WatchItem): WatchItem {
  const preview = item.preview ? item.preview.slice(0, WATCH_PREVIEW_MAX_CHARS) : item.preview;
  return { ...item, preview };
}

/**
 * Fold the user's items into one Watch frame. Pure: the caller decides what
 * counts as needing you (snoozes, followed tasks, …) and this only orders and
 * summarises. `waiting` wins over `offline` — a prompt you can still answer
 * matters more than a flaky host.
 */
export function buildWatchState(input: BuildWatchStateInput): WatchState {
  const now = input.now ?? new Date();
  const needsYou = input.needsYou.map(clampItem).sort((a, b) => a.since - b.since);
  const running = input.running.map(clampItem).sort((a, b) => b.since - a.since);

  let phase: WatchPhase;
  if (needsYou.length > 0) phase = "waiting";
  else if (input.offlineSince != null) phase = "offline";
  else if (running.length > 0) phase = "working";
  else phase = "done";

  const head = needsYou[0] ?? running[0] ?? null;

  return {
    phase,
    head,
    others: needsYou.slice(1, 1 + WATCH_OTHERS_MAX),
    needsYouCount: needsYou.length,
    runningCount: running.length,
    offlineSince: input.offlineSince ?? null,
    summary: input.summary ?? null,
    asOf: appleSeconds(now),
  };
}
