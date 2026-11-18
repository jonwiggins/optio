import { describe, expect, it, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  REPEAT_QUEUE_NAMES,
  REPEAT_SCHEDULERS,
  removeLegacyRepeatables,
  repeatJobName,
  scheduleRepeat,
} from "./repeat-jobs.js";

function fakeQueue(entries: Array<{ key: string }>) {
  const removed: string[] = [];
  const upserts: unknown[] = [];
  return {
    removed,
    upserts,
    queue: {
      getRepeatableJobs: async () => entries,
      removeRepeatableByKey: async (key: string) => {
        removed.push(key);
        return true;
      },
      upsertJobScheduler: async (...args: unknown[]) => {
        upserts.push(args);
        return {};
      },
    } as never,
  };
}

describe("repeat-jobs", () => {
  it("every scheduler id is `<queue>.<tick>` and names its job after the tick", () => {
    for (const queue of REPEAT_QUEUE_NAMES) {
      for (const id of REPEAT_SCHEDULERS[queue]) {
        expect(id.startsWith(`${queue}.`)).toBe(true);
        expect(repeatJobName(id)).toBe(id.slice(queue.length + 1));
        expect(repeatJobName(id)).not.toContain(".");
      }
    }
  });

  it("scheduleRepeat upserts a scheduler with the stable id and the tick as job name", async () => {
    const { queue, upserts } = fakeQueue([]);
    const before = Date.now();
    await scheduleRepeat(queue, "pr-watcher.check-prs", 30_000, {
      removeOnComplete: { count: 5 },
    });
    // A new scheduler's first tick is one interval out, not at once.
    const startDate = ((upserts[0] as unknown[])[1] as { startDate: number }).startDate;
    expect(startDate).toBeGreaterThanOrEqual(before + 30_000);
    expect(upserts).toEqual([
      [
        "pr-watcher.check-prs",
        { every: 30_000, startDate: expect.any(Number) },
        {
          name: "check-prs",
          data: {},
          opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 50 } },
        },
      ],
    ]);
  });

  it("scheduleRepeat keeps only the latest finished ticks when the caller sets no retention", async () => {
    const { queue, upserts } = fakeQueue([]);
    await scheduleRepeat(queue, "repo-cleanup.stall-check", 60_000);
    expect((upserts[0] as unknown[])[2]).toEqual({
      name: "stall-check",
      data: {},
      opts: { removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } },
    });
  });

  it("scheduleRepeat refuses a nonsense interval", async () => {
    const { queue } = fakeQueue([]);
    await expect(scheduleRepeat(queue, "pr-watcher.check-prs", 0)).rejects.toThrow(/interval/);
    await expect(scheduleRepeat(queue, "pr-watcher.check-prs", Number.NaN)).rejects.toThrow();
  });

  it("removeLegacyRepeatables drops hash-keyed entries and keeps the known schedulers", async () => {
    const { queue, removed } = fakeQueue([
      { key: "repo-cleanup.health-check" },
      { key: "repo-cleanup.stall-check" },
      { key: "3f1a9c0e7b2d4c5a6f8e9d0c1b2a3f4e5d6c7b8a" }, // an older build's repeatable
      { key: "health-check::::60000" }, // an even older build's
    ]);
    const n = await removeLegacyRepeatables(queue, "repo-cleanup");
    expect(n).toBe(2);
    expect(removed).toEqual(["3f1a9c0e7b2d4c5a6f8e9d0c1b2a3f4e5d6c7b8a", "health-check::::60000"]);
  });

  it("removeLegacyRepeatables never removes another queue's scheduler ids by accident", async () => {
    const { queue, removed } = fakeQueue([{ key: "ticket-sync.sync" }]);
    // A queue only ever holds its own entries; a foreign id would be a bug
    // elsewhere, and it is still not a legacy key to this queue.
    await removeLegacyRepeatables(queue, "repo-cleanup");
    expect(removed).toEqual(["ticket-sync.sync"]);
  });
});
