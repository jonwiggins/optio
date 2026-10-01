import { describe, expect, it } from "vitest";
import { sortWork, type WorkRow } from "./feed.js";

describe("sortWork", () => {
  const r = (key: string, status: WorkRow["status"], at: string, orderAt?: string) =>
    ({ key, status, lastActivity: at, orderAt }) as WorkRow;

  it("doesn't float needs-you above other live rows", () => {
    const rows = sortWork([
      r("waits", "needs_you", "2026-09-01T00:00:00Z"),
      r("runs", "running", "2026-09-02T00:00:00Z"),
      r("done", "done", "2026-09-03T00:00:00Z"),
    ]);
    expect(rows.map((x) => x.key)).toEqual(["runs", "waits", "done"]);
  });

  it("orders a session row by orderAt (last typed / created), not its activity", () => {
    const rows = sortWork([
      r("busy", "running", "2026-09-30T00:00:00Z", "2026-09-01T00:00:00Z"),
      r("typed", "needs_you", "2026-09-02T00:00:00Z", "2026-09-10T00:00:00Z"),
    ]);
    expect(rows.map((x) => x.key)).toEqual(["typed", "busy"]);
  });
});
