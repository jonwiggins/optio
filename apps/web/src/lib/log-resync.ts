import type { LogEntry } from "@/hooks/use-logs";
import { WS_RECONNECTED, type WsClient } from "@/lib/ws-client";

/** How many rows before the last one received a resync refetches from (ties, reordering). */
const RESYNC_OVERLAP = 100;

/**
 * The rows a log view missed while its socket was down: of `fetched` (a REST
 * page of the run's logs), those at or after the newest row the view had seen
 * that it doesn't hold. A reconnect only brings what is published from then
 * on — and the view ignores the socket's catch-up frames, REST being the
 * source of truth — so without this a row stored while it was away (an API
 * pod going away mid-run, another pod picking the run up) never shows.
 * Rows older than the newest seen are left alone, so a cleared view stays
 * cleared.
 */
export function missedLogs(
  known: LogEntry[],
  fetched: LogEntry[],
  newestSeen: string | null,
): LogEntry[] {
  const since = newestSeen ? Date.parse(newestSeen) : Number.NEGATIVE_INFINITY;
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const l of known) {
    if (l.id) ids.add(l.id);
    keys.add(l.timestamp + l.content);
  }
  return fetched.filter(
    (l) =>
      Date.parse(l.timestamp) >= since &&
      !(l.id && ids.has(l.id)) &&
      !keys.has(l.timestamp + l.content),
  );
}

/** `prev` with `missed` added, in time order (stable: equal times keep their order). */
export function withMissed(prev: LogEntry[], missed: LogEntry[]): LogEntry[] {
  if (missed.length === 0) return prev;
  return [...prev, ...missed].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

/** What a log view has received (REST and live), for a resync after its socket comes back. */
export class SeenLogs {
  count = 0;
  newest: string | null = null;
  private ids = new Set<string>();

  add(entries: LogEntry[]): void {
    this.count += entries.length;
    for (const e of entries) {
      if (!this.newest || Date.parse(e.timestamp) > Date.parse(this.newest))
        this.newest = e.timestamp;
      if (e.id) this.ids.add(e.id);
    }
  }

  /** A live frame for a row the view already holds (a resync fetched it first). */
  has(entry: LogEntry): boolean {
    return !!entry.id && this.ids.has(entry.id);
  }
}

/**
 * Each time `client`'s socket comes back after a drop, once the view's first
 * history load is done (`ready`), fetches the tail of the run's logs from
 * about where the view is (`fetchFrom(offset)`) and adds the rows it missed.
 */
export function resyncOnReconnect(
  client: WsClient,
  opts: {
    ready: Promise<unknown>;
    seen: SeenLogs;
    fetchFrom: (offset: number) => Promise<LogEntry[]>;
    setLogs: (update: (prev: LogEntry[]) => LogEntry[]) => void;
  },
): void {
  const { ready, seen, fetchFrom, setLogs } = opts;
  client.on(WS_RECONNECTED, () => {
    // What came before the drop is here; anything after it may not be. Taken
    // now: live frames after the reconnect may land before the fetch answers.
    const since = seen.newest;
    void ready
      .then(async () => {
        const fetched = await fetchFrom(Math.max(0, seen.count - RESYNC_OVERLAP));
        setLogs((prev) => withMissed(prev, missedLogs(prev, fetched, since)));
        seen.add(fetched.filter((e) => !seen.has(e)));
      })
      .catch(() => {});
  });
}
