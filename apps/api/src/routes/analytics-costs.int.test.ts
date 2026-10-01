/**
 * /api/analytics/costs against real Postgres: spend from every row kind that
 * carries AI usage — Repo Tasks, Job runs, and ad-hoc local sessions — lands
 * in the workspace's cost summary exactly once.
 */
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  localHosts,
  localTerminals,
  persistentAgents,
  persistentAgentTurns,
  prReviewRuns,
  prReviews,
} from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { analyticsRoutes } from "./analytics.js";

async function insertHost(workspaceId: string) {
  const [host] = await db
    .insert(localHosts)
    .values({ workspaceId, name: "laptop", hostname: "laptop.local", platform: "darwin" })
    .returning();
  return host;
}

async function insertLocalTerminal(
  hostId: string,
  workspaceId: string,
  overrides: Partial<typeof localTerminals.$inferInsert> = {},
) {
  const [row] = await db
    .insert(localTerminals)
    .values({
      hostId,
      workspaceId,
      title: "local session",
      dir: "/Users/it/repos/optio",
      spec: { kind: "agent" },
      state: "exited",
      exitCode: 0,
      ...overrides,
    })
    .returning();
  return row;
}

function usage(costUsd: number | null, model = "claude-sonnet-5") {
  return {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 3,
    model,
    costUsd,
    updatedAt: new Date().toISOString(),
  };
}

describe("GET /api/analytics/costs (integration)", () => {
  it("sums Repo Task, Job run, and unlinked local session spend once each", async () => {
    const ws = await insertWorkspace();
    const other = await insertWorkspace();
    const host = await insertHost(ws.id);

    await insertTask({ workspaceId: ws.id, costUsd: "1.5", state: "completed" });
    const wf = await insertWorkflow({ workspaceId: ws.id, name: "nightly" });
    await insertWorkflowRun(wf.id, { costUsd: "0.25", state: "completed" });

    // Ad-hoc local session: its cost lives only in local_terminals.usage.
    await insertLocalTerminal(host.id, ws.id, { usage: usage(0.75) });
    // Local session without priced usage — nothing to count.
    await insertLocalTerminal(host.id, ws.id, { usage: usage(null) });
    // Local session running a Task: the task row already carries its cost.
    const linked = await insertTask({ workspaceId: ws.id, costUsd: "2", runTarget: "local" });
    await insertLocalTerminal(host.id, ws.id, {
      taskId: linked.id,
      spawnedBy: "task",
      usage: usage(2),
    });
    // Another workspace's session must not leak in.
    const otherHost = await insertHost(other.id);
    await insertLocalTerminal(otherHost.id, other.id, { usage: usage(9) });

    const app = await buildRouteTestApp(analyticsRoutes, {
      user: { id: "u", workspaceId: ws.id, workspaceRole: "admin" },
    });
    const res = await app.inject({ method: "GET", url: "/api/analytics/costs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.summary.totalCost).toBe("4.5000");
    expect(body.summary.tasksWithCost).toBe(4);

    const byType = Object.fromEntries(
      body.costByType.map((r: { taskType: string; totalCost: number }) => [
        r.taskType,
        r.totalCost,
      ]),
    );
    expect(byType).toEqual({ coding: 3.5, job: 0.25, "local-session": 0.75 });

    const local = body.topTasks.find((t: { taskType: string }) => t.taskType === "local-session");
    expect(local).toMatchObject({
      repoUrl: "/Users/it/repos/optio",
      state: "completed",
      costUsd: "0.75",
      modelUsed: "claude-sonnet-5",
      inputTokens: 1000,
    });
  });

  it("counts persistent-agent turns, PR-review runs, and pod sessions, each linking to its page", async () => {
    const ws = await insertWorkspace();
    const [agent] = await db
      .insert(persistentAgents)
      .values({ workspaceId: ws.id, slug: "forge", name: "Forge", initialPrompt: "hi" })
      .returning();
    await db.insert(persistentAgentTurns).values([
      {
        agentId: agent.id,
        turnNumber: 1,
        wakeSource: "initial",
        costUsd: "0.5",
        finishedAt: new Date(),
        haltReason: "natural",
      },
      {
        agentId: agent.id,
        turnNumber: 2,
        wakeSource: "user",
        costUsd: "0.25",
        finishedAt: new Date(),
        haltReason: "error",
      },
    ]);
    const [review] = await db
      .insert(prReviews)
      .values({
        workspaceId: ws.id,
        prUrl: "https://github.com/acme/app/pull/3",
        prNumber: 3,
        repoOwner: "acme",
        repoName: "app",
        repoUrl: "https://github.com/acme/app",
        headSha: "abc",
      })
      .returning();
    const [reviewRun] = await db
      .insert(prReviewRuns)
      .values({
        prReviewId: review.id,
        kind: "initial",
        state: "completed",
        costUsd: "1",
        modelUsed: "claude-sonnet-5",
      })
      .returning();
    const [session] = await db
      .insert(interactiveSessions)
      .values({
        workspaceId: ws.id,
        repoUrl: "https://github.com/acme/app",
        branch: "s",
        costUsd: "2",
      })
      .returning();
    // A session that has not spent anything yet stores an empty string.
    await db.insert(interactiveSessions).values({
      workspaceId: ws.id,
      repoUrl: "https://github.com/acme/app",
      branch: "t",
      costUsd: "",
    });

    const app = await buildRouteTestApp(analyticsRoutes, {
      user: { id: "u", workspaceId: ws.id, workspaceRole: "admin" },
    });
    const res = await app.inject({ method: "GET", url: "/api/analytics/costs" });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();

    expect(body.summary.totalCost).toBe("3.7500");
    const byType = Object.fromEntries(
      body.costByType.map((r: { taskType: string; totalCost: number }) => [
        r.taskType,
        r.totalCost,
      ]),
    );
    expect(byType).toEqual({ "agent-turn": 0.75, "pr-review": 1, "pod-session": 2 });

    const hrefOf = (taskType: string) =>
      body.topTasks
        .filter((t: { taskType: string }) => t.taskType === taskType)
        .map((t: { href: string }) => t.href);
    expect(hrefOf("agent-turn")).toEqual([`/agents/${agent.id}`, `/agents/${agent.id}`]);
    expect(hrefOf("pr-review")).toEqual([`/reviews/${review.id}`]);
    expect(hrefOf("pod-session")).toEqual([`/sessions/${session.id}`]);
    expect(body.topTasks.find((t: { id: string }) => t.id === reviewRun.id)).toMatchObject({
      title: "Review acme/app#3",
      modelUsed: "claude-sonnet-5",
    });
    await app.close();
  });

  it("filters every breakdown by repoUrl (the anomalies join used to make it ambiguous)", async () => {
    const ws = await insertWorkspace();
    const repoUrl = "https://github.com/it-org/filtered";
    const otherRepo = "https://github.com/it-org/unfiltered";
    for (const cost of ["0.10", "0.10", "0.10"]) {
      await insertTask({ workspaceId: ws.id, repoUrl, costUsd: cost, state: "completed" });
    }
    const pricey = await insertTask({ workspaceId: ws.id, repoUrl, costUsd: "5", state: "failed" });
    await insertTask({ workspaceId: ws.id, repoUrl: otherRepo, costUsd: "7", state: "completed" });

    const app = await buildRouteTestApp(analyticsRoutes, {
      user: { id: "u", workspaceId: ws.id, workspaceRole: "admin" },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/analytics/costs?repoUrl=${encodeURIComponent(repoUrl)}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();

    expect(body.summary.totalCost).toBe("5.3000");
    expect(body.summary.tasksWithCost).toBe(4);
    expect(body.costByRepo.map((r: { repoUrl: string }) => r.repoUrl)).toEqual([repoUrl]);
    expect(body.anomalies.map((a: { id: string }) => a.id)).toEqual([pricey.id]);
    expect(body.topTasks.every((t: { repoUrl: string }) => t.repoUrl === repoUrl)).toBe(true);
    await app.close();
  });
});
