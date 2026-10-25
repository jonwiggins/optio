/**
 * The /api/analytics breakdowns against real Postgres: each counts only the
 * work the person asking may see (work-visibility.ts), as /costs does — a
 * member never reads another person's private work's error messages, repos
 * or counts.
 */
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { teams, users } from "../db/schema.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  getAgentAnalytics,
  getFailureAnalytics,
  getPerformanceAnalytics,
  getPrAnalytics,
} from "./analytics-service.js";
import type { Actor } from "./ownership.js";

async function insertUser() {
  const suffix = Math.random().toString(16).slice(2, 10);
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: `it-${suffix}`,
      email: `it-${suffix}@example.com`,
      displayName: `IT ${suffix}`,
    })
    .returning();
  return row;
}

describe("analytics-service — whose work a member's breakdowns count", () => {
  it("counts the member's own, their team's and the organization's work — not someone's private", async () => {
    const ws = await insertWorkspace();
    const [me, other] = [await insertUser(), await insertUser()];
    const [team] = await db
      .insert(teams)
      .values({ workspaceId: ws.id, name: "Platform", slug: `platform-${me.id.slice(0, 8)}` })
      .returning();
    const failed = { workspaceId: ws.id, state: "failed" as const, agentType: "claude-code" };
    await insertTask({ ...failed, errorMessage: "mine broke", ownerUserId: me.id });
    await insertTask({ ...failed, errorMessage: "secret broke", ownerUserId: other.id });
    await insertTask({
      ...failed,
      errorMessage: "team's broke",
      ownerUserId: other.id,
      ownerTeamId: team.id,
    });
    await insertTask({ ...failed, errorMessage: "org's broke", createdBy: other.id });
    // A private task with a PR, so /prs has someone else's work to leave out.
    await insertTask({
      workspaceId: ws.id,
      state: "pr_opened",
      ownerUserId: other.id,
      prUrl: "https://github.com/it-org/x/pull/1",
      prState: "open",
    });

    const member = (over: Partial<Actor> = {}): Actor => ({
      userId: me.id,
      workspaceId: ws.id,
      isAdmin: false,
      teamIds: [team.id],
      workVisibility: "organization",
      ...over,
    });
    const filters = { days: 30, workspaceId: ws.id };
    const messages = async (actor: Actor) =>
      (await getFailureAnalytics(filters, actor)).errorMessages.map((m) => m.message).sort();

    expect(await messages(member())).toEqual(["mine broke", "org's broke", "team's broke"]);
    // "teams" mode: the organization's work is an admin's (or its creator's).
    expect(await messages(member({ workVisibility: "teams" }))).toEqual([
      "mine broke",
      "team's broke",
    ]);
    expect(await messages(member({ isAdmin: true }))).toEqual([
      "mine broke",
      "org's broke",
      "secret broke",
      "team's broke",
    ]);

    const failures = await getFailureAnalytics(filters, member());
    expect(failures.failureByAgent).toEqual([
      { agentType: "claude-code", total: 3, failed: 3, failureRate: 100 },
    ]);

    const performance = await getPerformanceAnalytics(filters, member());
    expect(performance.tasksPerDay.reduce((n, d) => n + d.total, 0)).toBe(3);
    expect(
      (await getPerformanceAnalytics(filters, member({ isAdmin: true }))).tasksPerDay.reduce(
        (n, d) => n + d.total,
        0,
      ),
    ).toBe(5);

    const agents = await getAgentAnalytics(filters, member());
    expect(agents.agents.map((a) => [a.agentType, a.taskCount])).toEqual([["claude-code", 3]]);

    expect((await getPrAnalytics(filters, member())).totalPrs).toBe(0);
    expect((await getPrAnalytics(filters, member({ isAdmin: true }))).totalPrs).toBe(1);
    // Signed out (no user): nothing in "teams" mode.
    expect(
      await messages({ userId: null, workspaceId: ws.id, isAdmin: false, workVisibility: "teams" }),
    ).toEqual([]);
  });
});
