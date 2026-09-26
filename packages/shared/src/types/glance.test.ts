import { describe, expect, it } from "vitest";
import {
  appleSeconds,
  buildWatchState,
  WATCH_WHERE_DETAIL_MAX_CHARS,
  type WatchItem,
} from "./glance.js";

const NOW = new Date("2026-09-17T12:00:00Z");

function item(overrides: Partial<WatchItem> = {}): WatchItem {
  return {
    kind: "local",
    id: "t1",
    title: "claude-code · web",
    mono: "web",
    since: appleSeconds(NOW),
    state: "needs_you",
    link: "optio://local/t1?compose=1",
    ...overrides,
  };
}

describe("buildWatchState rows", () => {
  const at = (minutesAgo: number) => appleSeconds(NOW.getTime() - minutesAgo * 60_000);

  it("lists the items needing you after the head, oldest first", () => {
    const state = buildWatchState({
      needsYou: [
        item({ id: "n2", since: at(2) }),
        item({ id: "n9", since: at(9) }),
        item({ id: "n5", since: at(5) }),
        item({ id: "n1", since: at(1) }),
      ],
      running: [item({ id: "r1", state: "working", since: at(1) })],
      now: NOW,
    });
    expect(state.phase).toBe("waiting");
    expect([state.head?.id, ...state.others.map((o) => o.id)]).toEqual(["n9", "n5", "n2"]);
    expect(state.needsYouCount).toBe(4);
  });

  it("lists the running items, newest first, when nothing needs you", () => {
    const state = buildWatchState({
      needsYou: [],
      running: ["r7", "r1", "r3", "r2"].map((id) =>
        item({ id, state: "working", since: at(Number(id.slice(1))) }),
      ),
      now: NOW,
    });
    expect(state.phase).toBe("working");
    expect([state.head?.id, ...state.others.map((o) => o.id)]).toEqual(["r1", "r2", "r3"]);
    expect(state.runningCount).toBe(4);
  });
});

describe("buildWatchState (sessions)", () => {
  it("carries the board tiles when given, null otherwise", () => {
    const withCounts = buildWatchState({
      needsYou: [],
      running: [item({ state: "working" })],
      counts: { waiting: 1, recurring: 2, agents: 3 },
      now: NOW,
    });
    expect(withCounts).toMatchObject({ waitingCount: 1, recurringCount: 2, agentCount: 3 });
    const without = buildWatchState({ needsYou: [], running: [], now: NOW });
    expect(without.waitingCount).toBeNull();
    expect(without.recurringCount).toBeNull();
    expect(without.agentCount).toBeNull();
  });

  it("keeps the session chips and clamps a long Where head-first so the leaf survives", () => {
    const long = "MacBook Pro · ~/" + "very-long-directory-name/".repeat(6) + "web";
    const state = buildWatchState({
      needsYou: [
        item({
          source: "local-terminal",
          when: "now",
          where: { target: "machine", detail: long },
          who: "claude-code",
          then: "waits-for-me",
          statusLabel: "needs you",
        }),
      ],
      running: [],
      now: NOW,
    });
    const head = state.head!;
    expect(head).toMatchObject({
      source: "local-terminal",
      who: "claude-code",
      then: "waits-for-me",
    });
    expect(head.where?.target).toBe("machine");
    expect(head.where?.detail).toHaveLength(WATCH_WHERE_DETAIL_MAX_CHARS);
    expect(head.where?.detail?.startsWith("…")).toBe(true);
    expect(head.where?.detail?.endsWith("/web")).toBe(true);
  });

  it("leaves a short Where and a missing Where alone", () => {
    const state = buildWatchState({
      needsYou: [item({ where: { target: "pod", detail: "acme/web" } }), item({ id: "t2" })],
      running: [],
      now: NOW,
    });
    expect(state.head?.where).toEqual({ target: "pod", detail: "acme/web" });
    expect(state.others[0]?.where).toBeUndefined();
  });
});
