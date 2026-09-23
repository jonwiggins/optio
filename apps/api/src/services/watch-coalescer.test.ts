import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appleSeconds, buildWatchState, type WatchItem } from "@optio/shared";
import { mergeWatchEvent, WatchCoalescer, type WatchFrame } from "./watch-coalescer.js";

const NOW = new Date("2026-09-17T12:00:00Z");
const item = (id: string, state = "working"): WatchItem => ({
  kind: "local",
  id,
  title: "claude-code",
  mono: "web",
  since: appleSeconds(NOW),
  state,
  link: `optio://local/${id}`,
});
const frame = (
  event: WatchFrame<string>["event"],
  ids: string[],
  alert?: string,
): WatchFrame<string> => ({
  event,
  state: buildWatchState({ needsYou: [], running: ids.map((id) => item(id)), now: NOW }),
  alert,
});

function build(opts: { dropped?: boolean } = {}) {
  const sent: WatchFrame<string>[] = [];
  const coalescer = new WatchCoalescer<string, string, "ok">({
    coalesceMs: 1000,
    send: async (_target, f) => {
      sent.push(f);
      return "ok";
    },
    settle: async () => opts.dropped ?? false,
    onFlushError: () => {},
  });
  return { sent, coalescer };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("mergeWatchEvent", () => {
  it("never downgrades start / end to update; otherwise the newest event wins", () => {
    expect(mergeWatchEvent(undefined, "update")).toBe("update");
    expect(mergeWatchEvent("update", "update")).toBe("update");
    expect(mergeWatchEvent("end", "update")).toBe("end");
    expect(mergeWatchEvent("start", "update")).toBe("start");
    expect(mergeWatchEvent("start", "end")).toBe("end");
    expect(mergeWatchEvent("end", "start")).toBe("start");
    expect(mergeWatchEvent("update", "end")).toBe("end");
  });
});

describe("WatchCoalescer", () => {
  it("sends the first frame at once and folds a burst into one trailing push", async () => {
    const { sent, coalescer } = build();
    await coalescer.push("k", "t", frame("start", ["a"]));
    await coalescer.push("k", "t", frame("update", ["a", "b"], "ring"));
    await coalescer.push("k", "t", frame("update", ["a", "b", "c"]));
    expect(sent.map((f) => f.event)).toEqual(["start"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ event: "update", alert: "ring" });
    expect(sent[1].state.runningCount).toBe(3);
    coalescer.reset();
  });

  it("keeps a pending start a start when an update follows inside the window", async () => {
    const { sent, coalescer } = build();
    await coalescer.push("k", "t", frame("update", ["a"]));
    await coalescer.push("k", "t", frame("end", ["a"]));
    await coalescer.push("k", "t", frame("start", ["b"]));
    await coalescer.push("k", "t", frame("update", ["b", "c"]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.map((f) => f.event)).toEqual(["update", "start"]);
    expect(sent[1].state.runningCount).toBe(2);
    coalescer.reset();
  });

  it("dedupes identical updates, but never start / end / alerting frames", async () => {
    const { sent, coalescer } = build();
    await coalescer.push("k", "t", frame("update", ["a"]));
    await vi.advanceTimersByTimeAsync(1000);
    await coalescer.push("k", "t", frame("update", ["a"]));
    expect(sent).toHaveLength(1);
    await coalescer.push("k", "t", frame("update", ["a"], "ring"));
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await coalescer.push("k", "t", frame("end", ["a"]));
    expect(sent.map((f) => f.event)).toEqual(["update", "update", "end"]);
    // `end` opened no window and forgot the hash: the next frame goes straight out.
    await coalescer.push("k", "t", frame("update", ["a"]));
    expect(sent).toHaveLength(4);
    coalescer.reset();
  });

  it("forgets a dropped target's dedupe state", async () => {
    const { sent, coalescer } = build({ dropped: true });
    await coalescer.push("k", "t", frame("update", ["a"]));
    await vi.advanceTimersByTimeAsync(1000);
    await coalescer.push("k", "t", frame("update", ["a"]));
    expect(sent).toHaveLength(2);
    coalescer.reset();
  });

  it("keeps targets independent", async () => {
    const { sent, coalescer } = build();
    await coalescer.push("k1", "t1", frame("update", ["a"]));
    await coalescer.push("k2", "t2", frame("update", ["a"]));
    expect(sent).toHaveLength(2);
    coalescer.reset();
  });
});
