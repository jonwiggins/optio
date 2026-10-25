import { describe, it, expect } from "vitest";
import { isTaskStalled, getSilentDuration } from "./is-stalled.js";

describe("isTaskStalled", () => {
  const now = new Date("2026-04-07T12:00:00Z");

  it("returns false for non-running tasks", () => {
    expect(
      isTaskStalled({ state: "completed", lastActivityAt: new Date("2026-04-07T11:00:00Z") }, now),
    ).toBe(false);
  });

  it("returns false when lastActivityAt is not set", () => {
    expect(isTaskStalled({ state: "running", lastActivityAt: null }, now)).toBe(false);
    expect(isTaskStalled({ state: "running" }, now)).toBe(false);
  });

  it("never flags a task whose PR is open: it waits on a person, not on the agent", () => {
    const task = { state: "pr_opened", lastActivityAt: new Date("2026-04-01T00:00:00Z") };
    expect(isTaskStalled(task, now)).toBe(false);
    expect(getSilentDuration(task, now)).toBe(0);
  });

  it("does not infer a Local stall from its old task-row timestamp", () => {
    const task = {
      state: "running",
      runTarget: "local",
      lastActivityAt: new Date("2026-04-07T11:00:00Z"),
    };
    expect(isTaskStalled(task, now)).toBe(false);
    expect(getSilentDuration(task, now)).toBe(0);
    expect(isTaskStalled({ ...task, runTarget: "cluster" }, now)).toBe(true);
  });

  it("returns false when within threshold", () => {
    // 4 minutes silent, 5 min threshold
    const lastActivity = new Date("2026-04-07T11:56:00Z");
    expect(isTaskStalled({ state: "running", lastActivityAt: lastActivity }, now, 300_000)).toBe(
      false,
    );
  });

  it("returns true when past threshold", () => {
    // 6 minutes silent, 5 min threshold
    const lastActivity = new Date("2026-04-07T11:54:00Z");
    expect(isTaskStalled({ state: "running", lastActivityAt: lastActivity }, now, 300_000)).toBe(
      true,
    );
  });

  it("returns true when exactly at threshold", () => {
    // Exactly 5 minutes
    const lastActivity = new Date("2026-04-07T11:55:00Z");
    expect(isTaskStalled({ state: "running", lastActivityAt: lastActivity }, now, 300_000)).toBe(
      true,
    );
  });

  it("accepts string dates", () => {
    const lastActivity = "2026-04-07T11:54:00Z";
    expect(isTaskStalled({ state: "running", lastActivityAt: lastActivity }, now, 300_000)).toBe(
      true,
    );
  });

  it("uses default threshold when not provided", () => {
    // 4 minutes silent — should not be stalled (default is 5 min)
    const lastActivity = new Date("2026-04-07T11:56:00Z");
    expect(isTaskStalled({ state: "running", lastActivityAt: lastActivity }, now)).toBe(false);

    // 6 minutes silent — should be stalled
    const staleActivity = new Date("2026-04-07T11:54:00Z");
    expect(isTaskStalled({ state: "running", lastActivityAt: staleActivity }, now)).toBe(true);
  });

  it("respects custom threshold", () => {
    // 2 minutes silent, 1 min threshold → stalled
    const lastActivity = new Date("2026-04-07T11:58:00Z");
    expect(isTaskStalled({ state: "running", lastActivityAt: lastActivity }, now, 60_000)).toBe(
      true,
    );
  });

  it("handles per-repo 15-minute threshold", () => {
    // 10 minutes silent, 15 min threshold → NOT stalled
    const lastActivity = new Date("2026-04-07T11:50:00Z");
    expect(isTaskStalled({ state: "running", lastActivityAt: lastActivity }, now, 900_000)).toBe(
      false,
    );

    // 16 minutes silent, 15 min threshold → stalled
    const veryStale = new Date("2026-04-07T11:44:00Z");
    expect(isTaskStalled({ state: "running", lastActivityAt: veryStale }, now, 900_000)).toBe(true);
  });
});

describe("getSilentDuration", () => {
  const now = new Date("2026-04-07T12:00:00Z");

  it("returns 0 for non-running tasks", () => {
    expect(
      getSilentDuration(
        { state: "completed", lastActivityAt: new Date("2026-04-07T11:50:00Z") },
        now,
      ),
    ).toBe(0);
  });

  it("returns 0 when lastActivityAt is not set", () => {
    expect(getSilentDuration({ state: "running" }, now)).toBe(0);
  });

  it("returns correct duration", () => {
    const lastActivity = new Date("2026-04-07T11:55:00Z");
    expect(getSilentDuration({ state: "running", lastActivityAt: lastActivity }, now)).toBe(
      300_000,
    );
  });

  it("never returns negative", () => {
    // lastActivityAt in the future (clock skew)
    const future = new Date("2026-04-07T12:05:00Z");
    expect(getSilentDuration({ state: "running", lastActivityAt: future }, now)).toBe(0);
  });
});
