import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  sessionChatTurns,
  users,
  tasks,
  usageBudgets,
  localHosts,
  localTerminals,
  persistentAgents,
  persistentAgentTurns,
  prReviews,
  prReviewRuns,
  teams,
  teamMembers,
} from "../db/schema.js";
import {
  insertWorkspace,
  insertTask,
  insertWorkflow,
  insertWorkflowRun,
} from "../test-utils/integration/fixtures.js";
import { getUsage } from "./usage-service.js";
import { runBudgetHold, usageBudgetHold } from "./usage-budget-service.js";
import { usageRoutes } from "../routes/usage.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
const actor = (workspaceId: string, userId: string | null = null, isAdmin = true) => ({
  workspaceId,
  userId,
  isAdmin,
});
async function person() {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: randomUUID(),
      email: `${randomUUID()}@test.invalid`,
      displayName: "Alex",
    })
    .returning();
  return u;
}

describe("usage ledger", () => {
  it("records atomic deltas, costs without tokens, tokens without prices, and rolls back together", async () => {
    const ws = await insertWorkspace(),
      a = actor(ws.id);
    const task = await insertTask({
      workspaceId: ws.id,
      costUsd: "0.1",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
    });
    await db
      .update(tasks)
      .set({ costUsd: "0.3", inputTokens: 200, outputTokens: 30 })
      .where(eq(tasks.id, task.id));
    await db
      .update(tasks)
      .set({ costUsd: "0.3", inputTokens: 200, outputTokens: 30 })
      .where(eq(tasks.id, task.id));
    await expect(
      db.transaction(async (tx) => {
        await tx.update(tasks).set({ costUsd: "9", inputTokens: 900 }).where(eq(tasks.id, task.id));
        throw Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await insertTask({
      workspaceId: ws.id,
      inputTokens: 500,
      outputTokens: 70,
      state: "completed",
    });
    await insertTask({ workspaceId: ws.id, costUsd: "1.2", state: "completed" });
    const result = await getUsage({}, a);
    expect(result.summary).toMatchObject({
      tokens: 800,
      costUsd: "1.5",
      cachedTokens: 60,
      runs: 3,
      unpricedRuns: 1,
      unmeasuredRuns: 1,
    });
    expect(result.daily.reduce((n, d) => n + d.tokens, 0)).toBe(800);
  });
  it("ranks people and shared definitions separately, hides other private details, scopes every total", async () => {
    const ws = await insertWorkspace(),
      other = await insertWorkspace(),
      user = await person(),
      viewer = await person();
    await insertTask({
      workspaceId: ws.id,
      ownerUserId: user.id,
      title: "Private title",
      inputTokens: 600,
    });
    const wf = await insertWorkflow({
      workspaceId: ws.id,
      name: "Daily triage",
      createdBy: user.id,
    });
    await insertWorkflowRun(wf.id, { workspaceId: ws.id, inputTokens: 200, costUsd: "0.4" });
    await insertWorkflowRun(wf.id, { workspaceId: ws.id, inputTokens: 300, costUsd: "0.6" });
    await insertTask({ workspaceId: other.id, inputTokens: 9999 });
    const result = await getUsage({}, actor(ws.id, viewer.id, false));
    expect(result.summary.tokens).toBe(1100);
    expect(result.leaderboard.map((r) => [r.kind, r.name, r.tokens])).toEqual([
      ["person", "Alex", 600],
      ["work", "Daily triage", 500],
    ]);
    const privateResult = await getUsage(
      { subjectId: user.id, kind: "person" },
      actor(ws.id, viewer.id, false),
    );
    expect(privateResult.activity).toEqual([]);
    expect(privateResult.canInspect).toBe(false);
    expect(
      (await getUsage({ subjectId: wf.id, kind: "work" }, actor(ws.id, viewer.id, false))).activity,
    ).toHaveLength(2);
    const app = await buildRouteTestApp(usageRoutes, {
      user: { id: viewer.id, workspaceId: ws.id, workspaceRole: "member" },
    });
    const res = await app.inject({ url: "/api/analytics/usage?kind=work&sort=cost" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().summary.tokens).toBe(500);
    await app.close();
  });
  it("includes agent turns, reviews and Local cache tokens once; linked Local is charged only to its run", async () => {
    const ws = await insertWorkspace();
    const [agent] = await db
      .insert(persistentAgents)
      .values({
        workspaceId: ws.id,
        slug: "a",
        name: "Agent",
        initialPrompt: "Hi",
        totalCostUsd: "99",
      })
      .returning();
    await db.insert(persistentAgentTurns).values({
      agentId: agent.id,
      turnNumber: 1,
      wakeSource: "initial",
      inputTokens: 100,
      costUsd: "0.5",
      haltReason: "natural",
    });
    const [review] = await db
      .insert(prReviews)
      .values({
        workspaceId: ws.id,
        prUrl: "https://github.com/acme/app/pull/99",
        prNumber: 99,
        repoOwner: "acme",
        repoName: "app",
        repoUrl: "https://github.com/acme/app",
        headSha: "abc",
      })
      .returning();
    await db
      .insert(prReviewRuns)
      .values({ prReviewId: review.id, kind: "initial", inputTokens: 200, costUsd: "1" });
    const [host] = await db
      .insert(localHosts)
      .values({ workspaceId: ws.id, name: "laptop", hostname: "test", platform: "darwin" })
      .returning();
    const usage = {
      inputTokens: 30,
      outputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
      turns: 1,
      model: "unknown",
      costUsd: null,
      updatedAt: new Date().toISOString(),
    };
    await db.insert(localTerminals).values({
      workspaceId: ws.id,
      hostId: host.id,
      title: "Local",
      dir: "/tmp",
      spec: { kind: "agent" },
      usage,
    });
    const task = await insertTask({
      workspaceId: ws.id,
      inputTokens: 130,
      outputTokens: 10,
      costUsd: "0.2",
    });
    await db.insert(localTerminals).values({
      workspaceId: ws.id,
      hostId: host.id,
      title: "Linked",
      dir: "/tmp",
      spec: { kind: "agent" },
      taskId: task.id,
      usage,
    });
    const result = await getUsage({}, actor(ws.id));
    expect(result.summary).toMatchObject({ tokens: 580, runs: 4, unpricedRuns: 1 });
    expect(Number(result.summary.costUsd)).toBe(1.7);
  });
  it("enforces monthly organization, person and work admission limits without crossing scopes", async () => {
    const ws = await insertWorkspace(),
      user = await person();
    const shared = await insertTask({ workspaceId: ws.id, inputTokens: 100 });
    const owned = await insertTask({ workspaceId: ws.id, ownerUserId: user.id, inputTokens: 50 });
    const [budget] = await db
      .insert(usageBudgets)
      .values({
        workspaceId: ws.id,
        subjectKind: "person",
        subjectId: user.id,
        name: "Alex",
        tokenLimit: 50,
        action: "pause_new",
      })
      .returning();
    expect(await runBudgetHold("task", owned.id)).toContain("Alex");
    expect(await runBudgetHold("task", shared.id)).toBeNull();
    await db
      .update(usageBudgets)
      .set({ subjectKind: "work", subjectId: shared.id, name: "Shared", tokenLimit: 100 })
      .where(eq(usageBudgets.id, budget.id));
    expect(await runBudgetHold("task", shared.id)).toContain("Shared");
    expect(await runBudgetHold("task", owned.id)).toBeNull();
    await db
      .update(usageBudgets)
      .set({ subjectKind: "organization", subjectId: null, name: "Organization", tokenLimit: 150 })
      .where(eq(usageBudgets.id, budget.id));
    expect(await runBudgetHold("task", owned.id)).toContain("Organization");
    expect(await usageBudgetHold({ workspaceId: (await insertWorkspace()).id })).toBeNull();
    await db.update(usageBudgets).set({ action: "notify" }).where(eq(usageBudgets.id, budget.id));
    expect(await runBudgetHold("task", owned.id)).toBeNull();
    await db
      .update(usageBudgets)
      .set({ action: "pause_new", tokenLimit: 200 })
      .where(eq(usageBudgets.id, budget.id));
    expect(await runBudgetHold("task", owned.id)).toBeNull();
    await db.update(usageBudgets).set({ tokenLimit: 100 }).where(eq(usageBudgets.id, budget.id));
    await db.execute(
      sql`UPDATE usage_ledger SET occurred_at=date_trunc('month',now())-interval '1 day' WHERE workspace_id=${ws.id}::uuid`,
    );
    expect(await runBudgetHold("task", shared.id)).toBeNull();
  });

  it("preserves Local usage across attempts and ignores replayed or regressing daemon reports", async () => {
    const ws = await insertWorkspace();
    const [host] = await db
      .insert(localHosts)
      .values({ workspaceId: ws.id, name: "laptop", hostname: "test", platform: "darwin" })
      .returning();
    const task = await insertTask({ workspaceId: ws.id, state: "running", runTarget: "local" });
    const base = {
      workspaceId: ws.id,
      hostId: host.id,
      title: "Attempt",
      dir: "/tmp",
      spec: { kind: "agent" },
      taskId: task.id,
      state: "running" as const,
    };
    const report = (inputTokens: number, stamp: number) => ({
      inputTokens,
      outputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      turns: 1,
      model: "gpt-6.1-sol",
      costUsd: 0.2,
      updatedAt: new Date(stamp).toISOString(),
    });
    const [first] = await db
      .insert(localTerminals)
      .values({ ...base, usage: report(100, 1000) })
      .returning();
    const { syncLinkedRun } = await import("./local-run-service.js");
    await syncLinkedRun(first);
    const [second] = await db
      .insert(localTerminals)
      .values({ ...base, usage: report(50, 2000) })
      .returning();
    await db.update(tasks).set({ localTerminalId: second.id }).where(eq(tasks.id, task.id));
    await syncLinkedRun(second);
    const { handleUsage } = await import("./local-terminal-service.js");
    await handleUsage(host.id, second.id, report(100, 3000));
    await handleUsage(host.id, second.id, report(100, 3000));
    await handleUsage(host.id, second.id, report(50, 4000));
    const result = await getUsage({}, actor(ws.id));
    expect(result.summary.tokens).toBe(260);
    expect(Number(result.summary.costUsd)).toBe(0.4);
    expect(result.summary.runs).toBe(1);
  });
  it("does not charge a Local estimate again after an unpriced report", async () => {
    const ws = await insertWorkspace();
    const [host] = await db
      .insert(localHosts)
      .values({ workspaceId: ws.id, name: "Local", hostname: "test", platform: "darwin" })
      .returning();
    const usage = {
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 1,
      model: "gpt-6.1-sol",
      costUsd: 0.2,
      updatedAt: new Date().toISOString(),
    };
    const [terminal] = await db
      .insert(localTerminals)
      .values({
        workspaceId: ws.id,
        hostId: host.id,
        dir: "/tmp",
        title: "Local",
        spec: { kind: "agent" },
        usage,
      })
      .returning();
    await db
      .update(localTerminals)
      .set({ usage: { ...usage, inputTokens: 200, costUsd: null } })
      .where(eq(localTerminals.id, terminal.id));
    await db
      .update(localTerminals)
      .set({ usage: { ...usage, inputTokens: 300, costUsd: 0.3 } })
      .where(eq(localTerminals.id, terminal.id));
    const result = await getUsage({}, actor(ws.id));
    expect(result.summary.tokens).toBe(310);
    expect(Number(result.summary.costUsd)).toBe(0.3);
  });
  it("records pod session turns once with exact decimal increments", async () => {
    const ws = await insertWorkspace();
    const [session] = await db
      .insert(interactiveSessions)
      .values({
        workspaceId: ws.id,
        repoUrl: "https://github.com/acme/app",
        branch: "chat",
        costUsd: "",
      })
      .returning();
    const [turn] = await db
      .insert(sessionChatTurns)
      .values({ sessionId: session.id, requestId: randomUUID(), promptHash: "x", state: "running" })
      .returning();
    const { recordSessionUsage } = await import("../ws/session-chat.js");
    for (const costUsd of [0.1, 0.3, 0.3, 0.1])
      await recordSessionUsage(turn.id, session.id, {
        success: true,
        costUsd,
        inputTokens: 100,
        outputTokens: 20,
      });
    const [stored] = await db
      .select()
      .from(interactiveSessions)
      .where(eq(interactiveSessions.id, session.id));
    expect(stored.costUsd).toBe("0.3");
    const usage = await getUsage({}, actor(ws.id));
    expect(usage.summary.tokens).toBe(120);
    expect(usage.summary.costUsd).toBe("0.3");
    expect(usage.summary.runs).toBe(1);
  });
  it("supports budget upserts and rejects non-admin mutations", async () => {
    const ws = await insertWorkspace(),
      u = await person();
    const app = await buildRouteTestApp(usageRoutes, {
      user: { id: u.id, workspaceId: ws.id, workspaceRole: "admin" },
    });
    const body = {
      name: "Organization",
      subjectKind: "organization",
      tokenLimit: 1000,
      action: "pause_new",
    };
    let res = await app.inject({ method: "POST", url: "/api/usage/budgets", payload: body });
    expect(res.statusCode, res.body).toBe(200);
    res = await app.inject({
      method: "POST",
      url: "/api/usage/budgets",
      payload: { ...body, tokenLimit: 2000 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().budgets).toHaveLength(1);
    await app.close();
    const member = await buildRouteTestApp(usageRoutes, {
      user: { id: u.id, workspaceId: ws.id, workspaceRole: "member" },
    });
    expect(
      (await member.inject({ method: "POST", url: "/api/usage/budgets", payload: body }))
        .statusCode,
    ).toBe(403);
    await member.close();
  });
  it("groups a model with and without [1m] as one, and filters 'Not reported'", async () => {
    const ws = await insertWorkspace();
    await insertTask({
      workspaceId: ws.id,
      inputTokens: 100,
      outputTokens: 10,
      modelUsed: "claude-sonnet-5[1m]",
      state: "completed",
    });
    await insertTask({
      workspaceId: ws.id,
      inputTokens: 200,
      outputTokens: 20,
      modelUsed: "claude-sonnet-5",
      state: "completed",
    });
    await insertTask({ workspaceId: ws.id, inputTokens: 50, outputTokens: 5, state: "completed" });
    const all = await getUsage({}, actor(ws.id));
    expect(all.models).toEqual([
      { model: "claude-sonnet-5", tokens: 330, costUsd: null, runs: 2 },
      { model: "Not reported", tokens: 55, costUsd: null, runs: 1 },
    ]);
    const sonnet = await getUsage({ model: "claude-sonnet-5" }, actor(ws.id));
    expect(sonnet.summary).toMatchObject({ tokens: 330, runs: 2 });
    const none = await getUsage({ model: "Not reported" }, actor(ws.id));
    expect(none.summary).toMatchObject({ tokens: 55, runs: 1 });
    expect(none.models).toEqual([{ model: "Not reported", tokens: 55, costUsd: null, runs: 1 }]);
    // The literal suffix is still a valid filter for an old row's name.
    expect((await getUsage({ model: "claude-sonnet-5[1m]" }, actor(ws.id))).summary.runs).toBe(0);
  });
});

describe("usage activity: a person's teams' work (work-visibility.ts)", () => {
  it("shows a teammate's runs of the team's work — not their private work", async () => {
    const ws = await insertWorkspace();
    const [maker, viewer, outsider] = [await person(), await person(), await person()];
    const [team] = await db
      .insert(teams)
      .values({ workspaceId: ws.id, name: `T ${randomUUID()}`, slug: `t-${randomUUID()}` })
      .returning();
    await db.insert(teamMembers).values([
      { teamId: team.id, userId: maker.id },
      { teamId: team.id, userId: viewer.id },
    ]);
    // A team's work keeps its maker in owner_user_id: the ledger charges them.
    await insertTask({
      workspaceId: ws.id,
      ownerUserId: maker.id,
      ownerTeamId: team.id,
      title: "Team work",
      inputTokens: 300,
    });
    await insertTask({
      workspaceId: ws.id,
      ownerUserId: maker.id,
      title: "Maker's private work",
      inputTokens: 100,
    });
    const member = (userId: string, workVisibility: "organization" | "teams") => ({
      workspaceId: ws.id,
      userId,
      isAdmin: false,
      teamIds: userId === outsider.id ? [] : [team.id],
      workVisibility,
    });
    for (const mode of ["organization", "teams"] as const) {
      const seen = await getUsage({ subjectId: maker.id, kind: "person" }, member(viewer.id, mode));
      expect(seen.canInspect, mode).toBe(true);
      expect(seen.activity.map((a) => a.name)).toEqual(["Team work"]);
    }
    const stranger = await getUsage(
      { subjectId: maker.id, kind: "person" },
      member(outsider.id, "organization"),
    );
    expect(stranger.canInspect).toBe(false);
    expect(stranger.activity).toEqual([]);
  });
});
