/**
 * The PR-review worker against real Postgres: whose tokens a review runs on
 * (`reviewOwnerTeam`: a team's work's PR is reviewed on the team's tokens),
 * and agent text with a NUL in it settling a run instead of failing the
 * write (nul.ts).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { PrReviewRunState } from "@optio/shared";
import { db } from "../db/client.js";
import { prReviewRuns, prReviews, taskPrs, teamMembers, teams, users } from "../db/schema.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { reviewOwnerTeam, transitionRunFromActive } from "./pr-review-worker.js";

// These tests run with teams on (off by default).
vi.hoisted(() => {
  process.env.OPTIO_TEAMS_ENABLED = "true";
});

const uniq = () => randomBytes(4).toString("hex");

async function insertUser() {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: `it-${uniq()}`,
      email: `it-${uniq()}@example.com`,
      displayName: "IT",
    })
    .returning();
  return row;
}

describe("reviewOwnerTeam", () => {
  async function scene() {
    const ws = await insertWorkspace();
    const [member, outsider] = [await insertUser(), await insertUser()];
    const [team] = await db
      .insert(teams)
      .values({ workspaceId: ws.id, name: `team ${uniq()}`, slug: `team-${uniq()}` })
      .returning();
    await db.insert(teamMembers).values({ teamId: team.id, userId: member.id });
    const prUrl = `https://gitlab.example.com/it/app/-/merge_requests/${Math.floor(Math.random() * 1e6)}`;
    return { ws, member, outsider, team, prUrl };
  }

  it("a team's work's PR is reviewed on the team's tokens, for the org or a member", async () => {
    const { ws, member, outsider, team, prUrl } = await scene();
    await insertTask({
      workspaceId: ws.id,
      ownerUserId: member.id,
      ownerTeamId: team.id,
      prUrl,
    });
    const review = { prUrl, workspaceId: ws.id };
    expect(await reviewOwnerTeam({ ...review, createdBy: null })).toBe(team.id);
    expect(await reviewOwnerTeam({ ...review, createdBy: member.id })).toBe(team.id);
    // Someone outside the team runs it on their own tokens.
    expect(await reviewOwnerTeam({ ...review, createdBy: outsider.id })).toBeNull();
    // Another workspace's review of the same URL is not the team's.
    const other = await insertWorkspace();
    expect(await reviewOwnerTeam({ prUrl, workspaceId: other.id, createdBy: null })).toBeNull();
  });

  it("finds the team through a PR the task tracks, and is null for no team's PR", async () => {
    const { ws, member, team, prUrl } = await scene();
    const task = await insertTask({
      workspaceId: ws.id,
      ownerUserId: member.id,
      ownerTeamId: team.id,
    });
    expect(await reviewOwnerTeam({ prUrl, workspaceId: ws.id, createdBy: null })).toBeNull();
    await db.insert(taskPrs).values({
      taskId: task.id,
      repoUrl: "https://gitlab.example.com/it/app",
      number: 1,
      url: prUrl,
      source: "attached",
    });
    expect(await reviewOwnerTeam({ prUrl, workspaceId: ws.id, createdBy: null })).toBe(team.id);
    // Personal work's PR: no team.
    const personal = `${prUrl}0`;
    await insertTask({ workspaceId: ws.id, ownerUserId: member.id, prUrl: personal });
    expect(
      await reviewOwnerTeam({ prUrl: personal, workspaceId: ws.id, createdBy: null }),
    ).toBeNull();
  });
});

describe("a review run's agent text with a NUL", () => {
  it("is stored with U+FFFD instead of failing the write", async () => {
    const [review] = await db
      .insert(prReviews)
      .values({
        prUrl: `https://gitlab.example.com/it/app/-/merge_requests/${uniq()}`,
        prNumber: 1,
        repoOwner: "it",
        repoName: "app",
        repoUrl: "https://gitlab.example.com/it/app",
        headSha: "abc",
      })
      .returning();
    const [run] = await db
      .insert(prReviewRuns)
      .values({ prReviewId: review.id, state: PrReviewRunState.RUNNING })
      .returning();

    const failed = await transitionRunFromActive(run.id, PrReviewRunState.FAILED, {
      errorMessage: "agent said \u0000 here",
      resultSummary: "half\u0000done",
    });
    expect(failed?.state).toBe(PrReviewRunState.FAILED);
    const [row] = await db.select().from(prReviewRuns).where(eq(prReviewRuns.id, run.id));
    expect(row.errorMessage).toBe("agent said � here");
    expect(row.resultSummary).toBe("half�done");
  });
});
