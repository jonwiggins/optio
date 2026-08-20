import { describe, it, expect } from "vitest";
import {
  AttentionTracker,
  mapHookEvent,
  type AttentionEvent,
  type AttentionScheduler,
} from "../local/attention.js";

class FakeScheduler implements AttentionScheduler {
  private timers = new Map<number, () => void>();
  private nextId = 1;

  setTimeout(fn: () => void, _ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, fn);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pending(): number {
    return this.timers.size;
  }

  fireAll(): void {
    const fns = [...this.timers.values()];
    this.timers.clear();
    for (const fn of fns) fn();
  }
}

function setup() {
  const events: AttentionEvent[] = [];
  const scheduler = new FakeScheduler();
  const tracker = new AttentionTracker({
    onEvent: (event) => events.push(event),
    scheduler,
  });
  return { events, scheduler, tracker };
}

const T = "term-1";

describe("attention bell scanner", () => {
  it("raw BEL emits needs_you/bell", () => {
    const { events, tracker } = setup();
    tracker.feed(T, Buffer.from("build done\x07"));
    expect(events).toEqual([
      { terminalId: T, state: "working", reason: "output" },
      { terminalId: T, state: "needs_you", reason: "bell" },
    ]);
  });

  it("BEL terminating an OSC title sequence is NOT an attention bell", () => {
    const { events, tracker } = setup();
    tracker.feed(T, Buffer.from("\x1b]0;window title\x07regular output"));
    expect(events).toEqual([{ terminalId: T, state: "working", reason: "output" }]);
  });

  it("OSC split across two chunks (ESC in one, ] in the next) is still a terminator", () => {
    const { events, tracker } = setup();
    tracker.feed(T, Buffer.from("\x1b"));
    tracker.feed(T, Buffer.from("]0;split title\x07"));
    expect(events.filter((e) => e.state === "needs_you")).toEqual([]);
  });

  it("OSC body split across chunks with BEL terminator emits nothing", () => {
    const { events, tracker } = setup();
    tracker.feed(T, Buffer.from("\x1b]0;first ha"));
    tracker.feed(T, Buffer.from("lf second half\x07"));
    expect(events.filter((e) => e.state === "needs_you")).toEqual([]);
  });

  it("ESC \\ (ST) terminated OSC followed by a raw BEL IS an attention bell", () => {
    const { events, tracker } = setup();
    tracker.feed(T, Buffer.from("\x1b]0;title\x1b\\\x07"));
    expect(events.at(-1)).toEqual({ terminalId: T, state: "needs_you", reason: "bell" });
  });

  it("DCS/APC/PM openers also swallow their BEL terminator", () => {
    for (const opener of ["P", "_", "^"]) {
      const { events, tracker } = setup();
      tracker.feed(T, Buffer.from(`\x1b${opener}payload\x07`));
      expect(events.filter((e) => e.state === "needs_you")).toEqual([]);
    }
  });

  it("does not re-emit needs_you/bell for repeated bells without other transitions", () => {
    const { events, tracker } = setup();
    tracker.feed(T, Buffer.from("\x07\x07"));
    expect(events.filter((e) => e.reason === "bell")).toHaveLength(1);
  });
});

describe("attention output/silence heuristics", () => {
  it("output transitions to working (only once while already working)", () => {
    const { events, tracker } = setup();
    tracker.feed(T, Buffer.from("one"));
    tracker.feed(T, Buffer.from("two"));
    expect(events).toEqual([{ terminalId: T, state: "working", reason: "output" }]);
  });

  it("silence after output transitions to idle (not needs_you)", () => {
    const { events, scheduler, tracker } = setup();
    tracker.feed(T, Buffer.from("output"));
    scheduler.fireAll();
    expect(events.at(-1)).toEqual({ terminalId: T, state: "idle", reason: "silence" });
  });

  it("output resets the silence timer", () => {
    const { events, scheduler, tracker } = setup();
    tracker.feed(T, Buffer.from("one"));
    tracker.feed(T, Buffer.from("two"));
    expect(scheduler.pending).toBe(1); // old timer cleared, one armed
    scheduler.fireAll();
    expect(events.at(-1)?.state).toBe("idle");
  });

  it("output after idle transitions back to working", () => {
    const { events, scheduler, tracker } = setup();
    tracker.feed(T, Buffer.from("output"));
    scheduler.fireAll();
    tracker.feed(T, Buffer.from("more"));
    expect(events.at(-1)).toEqual({ terminalId: T, state: "working", reason: "output" });
  });

  it("remove() clears the pending silence timer", () => {
    const { events, scheduler, tracker } = setup();
    tracker.feed(T, Buffer.from("output"));
    tracker.remove(T);
    scheduler.fireAll();
    expect(events.filter((e) => e.state === "idle")).toEqual([]);
  });
});

describe("hook mapping", () => {
  it("maps Stop/Notification/UserPromptSubmit to the expected (state, reason)", () => {
    expect(mapHookEvent("Stop")).toEqual({ state: "needs_you", reason: "stop" });
    expect(mapHookEvent("Notification")).toEqual({ state: "needs_you", reason: "notification" });
    expect(mapHookEvent("UserPromptSubmit")).toEqual({ state: "working", reason: "prompt" });
    expect(mapHookEvent("PreToolUse")).toBeNull();
  });

  it("hookEvent emits the mapped transition", () => {
    const { tracker } = setup();
    expect(tracker.hookEvent(T, "Stop")).toEqual([
      { terminalId: T, state: "needs_you", reason: "stop" },
    ]);
    expect(tracker.hookEvent(T, "UserPromptSubmit")).toEqual([
      { terminalId: T, state: "working", reason: "prompt" },
    ]);
    expect(tracker.hookEvent(T, "Notification")).toEqual([
      { terminalId: T, state: "needs_you", reason: "notification" },
    ]);
  });

  it("hasHooks disables subsequent bell and silence heuristics", () => {
    const { events, scheduler, tracker } = setup();
    tracker.feed(T, Buffer.from("booting")); // arms the silence timer
    tracker.hookEvent(T, "UserPromptSubmit");
    expect(tracker.hasHooks(T)).toBe(true);
    expect(scheduler.pending).toBe(0); // silence timer cleared

    expect(tracker.feed(T, Buffer.from("ding\x07"))).toEqual([]);
    scheduler.fireAll();
    expect(events.filter((e) => e.reason === "bell" || e.reason === "silence")).toEqual([]);
  });

  it("an unknown hook event still marks hasHooks (no transition)", () => {
    const { tracker } = setup();
    expect(tracker.hookEvent(T, "PreToolUse")).toEqual([]);
    expect(tracker.hasHooks(T)).toBe(true);
    expect(tracker.feed(T, Buffer.from("\x07"))).toEqual([]);
  });

  it("does not affect other terminals", () => {
    const { tracker } = setup();
    tracker.hookEvent(T, "Stop");
    const other = tracker.feed("term-2", Buffer.from("\x07"));
    expect(other.at(-1)).toEqual({ terminalId: "term-2", state: "needs_you", reason: "bell" });
  });
});
