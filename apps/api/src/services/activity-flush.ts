/**
 * A running agent's "last activity", debounced: the worker streaming its
 * output marks each parsed event, and the latest sign of life is written at
 * most once per interval (and once more when the stream ends). Stall
 * detection reads it as the run's heartbeat without a DB write per event.
 */

/** Agent events that count as signs of life for stall detection. */
const ACTIVITY_EVENTS: ReadonlySet<string> = new Set([
  "text",
  "tool_use",
  "tool_result",
  "thinking",
  "system",
]);

export function activityFlusher(write: (at: Date) => Promise<unknown>, intervalMs: number) {
  let pendingAt: Date | null = null;
  let flushedAt = 0;
  const flush = async () => {
    if (!pendingAt) return;
    await write(pendingAt);
    pendingAt = null;
    flushedAt = Date.now();
  };
  return {
    /** Note a parsed agent event; only the kinds that are signs of life count. */
    mark(eventType: string) {
      if (ACTIVITY_EVENTS.has(eventType)) pendingAt = new Date();
    },
    /** Write the latest sign of life once the interval since the last write has passed. */
    async maybeFlush() {
      if (Date.now() - flushedAt > intervalMs) await flush();
    },
    /** Write whatever is pending now (the stream ended). */
    flush,
  };
}
