/**
 * GET /api/runs/recent against real Postgres: one raw UNION ALL over the
 * runs table (repo tasks and Job runs) and persistent-agent turns, so its
 * SQL only shows it works on a real database.
 */
import { describe, expect, it } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { recentRunsRoutes, type RecentRun } from "./recent-runs.js";

async function seed() {
  const ws = await insertWorkspace();
  const other = await insertWorkspace();
  const task = await insertTask({
    workspaceId: ws.id,
    title: "Fix login",
    repoUrl: "https://github.com/acme/web",
    state: "failed",
    errorMessage: "boom",
    agentType: "codex",
    costUsd: "0.25",
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  });
  // A subtask is part of its parent's run, not a row of its own.
  await insertTask({ workspaceId: ws.id, parentTaskId: task.id, title: "review" });
  const job = await insertWorkflow({
    workspaceId: ws.id,
    name: "Nightly report",
    agentType: "gemini",
  });
  const run = await insertWorkflowRun(job.id, {
    title: "Report for Monday",
    state: "completed",
    costUsd: "0.5",
    startedAt: new Date("2026-09-02T00:00:00Z"),
    finishedAt: new Date("2026-09-02T00:05:00Z"),
    updatedAt: new Date("2026-09-02T00:05:00Z"),
  });
  const foreignTask = await insertTask({ workspaceId: other.id, title: "theirs" });
  const foreignJob = await insertWorkflow({ workspaceId: other.id });
  const foreignRun = await insertWorkflowRun(foreignJob.id);
  return { ws, task, job, run, foreign: [foreignTask.id, foreignRun.id] };
}

describe("GET /api/runs/recent (integration)", () => {
  it("lists repo tasks and Job runs, newest first, in the caller's workspace", async () => {
    const { ws, task, job, run, foreign } = await seed();
    const app = await buildRouteTestApp(recentRunsRoutes, {
      user: { id: "user-1", workspaceId: ws.id, workspaceRole: "member" },
    });

    const res = await app.inject({ method: "GET", url: "/api/runs/recent?limit=50" });
    expect(res.statusCode, res.body).toBe(200);
    const runs = (res.json() as { runs: RecentRun[] }).runs;

    expect(runs.map((r) => r.id)).toEqual([run.id, task.id]);
    expect(runs.map((r) => r.id)).not.toEqual(expect.arrayContaining(foreign));
    expect(runs[0]).toEqual({
      id: run.id,
      kind: "job-run",
      title: "Nightly report",
      state: "completed",
      parentId: job.id,
      href: `/jobs/${job.id}/runs/${run.id}`,
      where: null,
      detail: null,
      agentType: "gemini",
      costUsd: "0.5",
      at: "2026-09-02T00:05:00.000Z",
      startedAt: "2026-09-02T00:00:00.000Z",
      endedAt: "2026-09-02T00:05:00.000Z",
    });
    expect(runs[1]).toEqual({
      id: task.id,
      kind: "task",
      title: "Fix login",
      state: "failed",
      parentId: "https://github.com/acme/web",
      href: `/tasks/${task.id}`,
      where: "acme/web",
      detail: "boom",
      agentType: "codex",
      costUsd: "0.25",
      at: "2026-09-01T00:00:00.000Z",
      startedAt: null,
      endedAt: null,
    });
    await app.close();
  });

  it("keeps the newest `limit` rows across kinds", async () => {
    const { ws, run } = await seed();
    const app = await buildRouteTestApp(recentRunsRoutes, {
      user: { id: "user-1", workspaceId: ws.id, workspaceRole: "member" },
    });
    const res = await app.inject({ method: "GET", url: "/api/runs/recent?limit=1" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { runs: RecentRun[] }).runs.map((r) => r.id)).toEqual([run.id]);
    await app.close();
  });
});
