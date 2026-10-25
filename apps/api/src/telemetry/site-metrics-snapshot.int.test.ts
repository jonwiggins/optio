/**
 * What the site metrics' run gauges read (docs/observability.md "Prometheus
 * endpoint and dashboard"), against a real database: the runs query stays on the
 * (kind, state) index — every API replica runs it every 30 s over every run
 * ever made — and a queued run a repo's "Off-peak only" holds on purpose
 * doesn't make the queue look stuck.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { insertRepo, insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { readSiteSnapshot, runsQuery } from "./site-metrics-snapshot.js";

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const PEAK = { peak: true, openedAt: new Date() };

describe("the runs query", () => {
  it("compares the state as the column's enum, so Postgres can use its index", async () => {
    // A few thousand finished runs and a handful of live ones.
    await db.execute(sql`
      INSERT INTO tasks (title, prompt, repo_url, agent_type, state)
      SELECT 'old', 'p', 'https://gitlab.example.test/a/b', 'claude-code', 'completed'
      FROM generate_series(1, 3000)`);
    await db.execute(sql`ANALYZE tasks`);
    const plan = await db.transaction(async (tx) => {
      // Only the plan's shape matters: a cast on `state` leaves no index
      // condition on it, whatever the planner's costs.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows = await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${runsQuery(PEAK)}`);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toMatch(/Index Cond: \(+(?:t\.)?state = ANY/);
    expect(plan).not.toMatch(/Filter: .*\(t\.state\)::text/);
  });
});

describe("the oldest queued run, with a repo's off-peak hold", () => {
  it("leaves held runs out during peak hours, and counts them from the window's opening after", async () => {
    const ws = await insertWorkspace();
    const offPeak = await insertRepo({ workspaceId: ws.id, offPeakOnly: true });
    const anytime = await insertRepo({ workspaceId: ws.id });
    // Held since this morning's peak began (the worker stamped it then).
    await insertTask({
      workspaceId: ws.id,
      repoUrl: offPeak.repoUrl,
      state: "queued",
      updatedAt: minutesAgo(180),
    });
    // Waiting on Optio: a run someone told to ignore the hold, another repo's run.
    await insertTask({
      workspaceId: ws.id,
      repoUrl: offPeak.repoUrl,
      state: "queued",
      ignoreOffPeak: true,
      updatedAt: minutesAgo(12),
    });
    await insertTask({
      workspaceId: ws.id,
      repoUrl: anytime.repoUrl,
      state: "queued",
      updatedAt: minutesAgo(10),
    });

    const queued = async (offPeakWindow: { peak: boolean; openedAt: Date }) => {
      const { snapshot } = await readSiteSnapshot({ spend: false, offPeak: offPeakWindow });
      return snapshot.runs.find((r) => r.kind === "repo" && r.state === "queued")!;
    };

    // Peak hours: the held run is still counted as queued, not as waiting.
    const peak = await queued(PEAK);
    expect(peak.count).toBe(3);
    expect(peak.oldestSeconds).toBeGreaterThanOrEqual(12 * 60 - 5);
    expect(peak.oldestSeconds).toBeLessThan(14 * 60);

    // The window opened 20 minutes ago: it has waited 20 minutes, not 3 hours.
    const opened = await queued({ peak: false, openedAt: minutesAgo(20) });
    expect(opened.oldestSeconds).toBeGreaterThanOrEqual(20 * 60 - 5);
    expect(opened.oldestSeconds).toBeLessThan(22 * 60);

    // Queued during an off-peak window (before it opened): its own time.
    const before = await queued({ peak: false, openedAt: minutesAgo(300) });
    expect(before.oldestSeconds).toBeGreaterThanOrEqual(180 * 60 - 5);

    // Another workspace's repo of the same URL with the hold doesn't hold this one.
    const other = await insertWorkspace();
    await insertRepo({ workspaceId: other.id, repoUrl: anytime.repoUrl, offPeakOnly: true });
    await db.execute(sql`UPDATE tasks SET updated_at = ${minutesAgo(40).toISOString()}::timestamptz
        WHERE repo_url = ${anytime.repoUrl}`);
    expect((await queued(PEAK)).oldestSeconds).toBeGreaterThanOrEqual(40 * 60 - 5);
  });
});
