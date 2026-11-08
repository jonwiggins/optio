/**
 * Phase C1 of docs/plans/scale-out.md against the real database and Redis:
 * every place two API instances could step on each other is driven by two
 * concurrent callers here, and each must settle exactly once.
 *
 *   - the concurrency claim under the advisory lock never admits more than
 *     the limit, however many claimers race;
 *   - a poller's turn, a ticket's sync claim, an inbound webhook delivery,
 *     a WebSocket upgrade token and a schedule trigger's tick each go to one
 *     of two racing callers;
 *   - two overlapping schedule sweeps fire a due trigger once; two
 *     overlapping ticket syncs create one task per ticket; two overlapping
 *     external-PR sweeps launch (and relaunch) a review once;
 *   - a claim that can't get the lock in time gives up (null) after the
 *     lock timeout; after-commit steps run only after a commit;
 *   - a person's PR review launch relaunches the review as it is, a sweep's
 *     only the version it saw;
 *   - two instances refreshing one user's GitHub token call GitHub once,
 *     and a refused refresh deletes only the tokens it used;
 *   - repeat jobs are schedulers with stable ids: two instances registering
 *     leave one, and an older build's hash-keyed repeatable is removed while
 *     the scheduler stays.
 */
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { TaskState } from "@optio/shared";
import { db } from "../db/client.js";
import {
  prReviewRuns,
  prReviews,
  tasks,
  ticketProviders,
  users,
  workflowRuns,
} from "../db/schema.js";
import { TASK_CLAIM_KEY, claimKey, withClaimLock } from "./claim-lock.js";
import { claimInboundDelivery } from "./inbound-delivery-service.js";
import { underPollerLease } from "./poller-lease.js";
import { REPEAT_SCHEDULERS, removeLegacyRepeatables, scheduleRepeat } from "./repeat-jobs.js";
import { createWsToken, validateWsToken } from "./session-service.js";
import * as taskService from "./task-service.js";
import {
  claimTicketForSync,
  recordTicketClaimTask,
  releaseTicketClaim,
} from "./ticket-sync-service.js";
import { advanceScheduleCas, getTrigger } from "./trigger-service.js";
import { getBullMQOptions } from "./redis-config.js";
import { getRedisClient } from "./event-bus.js";
import { checkDueScheduleTriggers } from "../workers/workflow-trigger-worker.js";
import { sweepExternalPrs } from "../workers/external-pr-review-worker.js";
import { prReviewRunQueue } from "../workers/pr-review-worker.js";
import { syncAllTickets } from "./ticket-sync-service.js";
import { launchPrReview } from "./pr-review-service.js";
import { refreshUserTokenLeased, storeUserGitHubTokens } from "./github-token-service.js";
import { retrieveSecret } from "./secret-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { workflowRunQueue } from "../workers/workflow-worker.js";
import { reconcileQueue } from "./reconcile-queue.js";
import {
  insertRepo,
  insertTask,
  insertWorkflow,
  insertWorkflowTrigger,
} from "../test-utils/integration/fixtures.js";

// The outside world the sweeps poll: one ticket provider and one git
// platform, each answering from what the test put here (and slow enough
// that two sweeps overlap for real).
const outside = vi.hoisted(() => ({
  tickets: [] as Array<Record<string, unknown>>,
  prs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@optio/ticket-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@optio/ticket-providers")>()),
  getTicketProvider: () => ({
    fetchActionableTickets: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return outside.tickets;
    },
    fetchTicketComments: async () => [],
    addComment: async () => {},
  }),
}));

vi.mock("./git-token-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-token-service.js")>()),
  getGitPlatformForRepo: async () => ({
    ri: { platform: "github", host: "github.com", owner: "it-org", repo: "it-repo" },
    platform: {
      listOpenPullRequests: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return outside.prs;
      },
      getPullRequest: async (_ri: unknown, n: number) => {
        const pr = outside.prs.find((p) => p.number === n)!;
        return { title: pr.title, body: "", headSha: pr.headSha };
      },
      getReviews: async () => [],
      getIssueComments: async () => [],
      getInlineComments: async () => [],
      getCIChecks: async () => [],
    },
  }),
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  await db.execute(sql`DELETE FROM "leases"`);
});

afterAll(async () => {
  await Promise.allSettled([
    taskQueue.close(),
    workflowRunQueue.close(),
    prReviewRunQueue.close(),
    reconcileQueue.close(),
    getRedisClient().quit(),
  ]);
});

describe("claims under the advisory lock", () => {
  it("two racing claimers never admit more than the limit over 50 iterations", async () => {
    // A 400-character repo URL: the repo's limit is counted under the global key.
    const repoUrl = `https://github.com/it-org/claims-${randomUUID().slice(0, 8)}-${"x".repeat(360)}`;
    expect(repoUrl.length).toBeGreaterThanOrEqual(400);
    const limit = 3;
    const iterations = 50;
    const queued = await Promise.all(
      Array.from({ length: iterations * 2 }, () =>
        insertTask({ repoUrl, state: TaskState.QUEUED }),
      ),
    );
    const pending = queued.map((t) => t.id);
    const active = sql`${tasks.repoUrl} = ${repoUrl} AND ${tasks.state} IN ('provisioning', 'running')`;
    const activeCount = async () => {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(active);
      return Number(count);
    };

    // Watch the count from outside the lock the whole time.
    let watching = true;
    let maxSeen = 0;
    const watcher = (async () => {
      while (watching) {
        maxSeen = Math.max(maxSeen, await activeCount());
        await sleep(1);
      }
    })();

    let claimed = 0;
    const claimer = async () => {
      const mine: string[] = [];
      for (let i = 0; i < iterations; i++) {
        const id = pending.pop()!;
        const claim = await withClaimLock([TASK_CLAIM_KEY], async (c) => {
          const [{ count }] = await c.tx
            .select({ count: sql<number>`count(*)::int` })
            .from(tasks)
            .where(active);
          if (Number(count) >= limit) return null;
          return taskService.claimTransitionIn(c, id, TaskState.PROVISIONING, "it_claim");
        });
        if (claim) {
          claimed++;
          mine.push(id);
        }
        maxSeen = Math.max(maxSeen, await activeCount());
        // Runs finish at random, so the count goes up and down.
        if (mine.length > 0 && Math.random() < 0.5) {
          await sleep(Math.floor(Math.random() * 5));
          await db
            .update(tasks)
            .set({ state: TaskState.FAILED })
            .where(eq(tasks.id, mine.shift()!));
        }
      }
    };
    await Promise.all([claimer(), claimer()]);
    watching = false;
    await watcher;

    expect(maxSeen).toBeLessThanOrEqual(limit);
    expect(maxSeen).toBe(limit); // the limit was reached, and held
    expect(claimed).toBeGreaterThan(limit); // runs came and went
    expect(await activeCount()).toBeLessThanOrEqual(limit);
  }, 60_000);

  it("runs after-commit steps once the claim commits, and drops them on rollback", async () => {
    const task = await insertTask({ state: TaskState.QUEUED });
    const seen: string[] = [];
    const claimed = await withClaimLock([TASK_CLAIM_KEY], async (c) => {
      c.afterCommit(async () => {
        // Committed by now: another connection sees the claim.
        const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
        seen.push(row.state);
      });
      return taskService.claimTransitionIn(c, task.id, TaskState.PROVISIONING, "it_claim");
    });
    expect(claimed?.state).toBe(TaskState.PROVISIONING);
    expect(seen).toEqual([TaskState.PROVISIONING]);

    const other = await insertTask({ state: TaskState.QUEUED });
    let ran = false;
    await expect(
      withClaimLock([TASK_CLAIM_KEY], async (c) => {
        await taskService.claimTransitionIn(c, other.id, TaskState.PROVISIONING, "it_claim");
        c.afterCommit(() => {
          ran = true;
        });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(ran).toBe(false);
    const [still] = await db.select().from(tasks).where(eq(tasks.id, other.id));
    expect(still.state).toBe(TaskState.QUEUED);
  });

  it("takes a key of any length (hashtext)", async () => {
    const key = claimKey("claim:repo", `https://github.com/acme/${"r".repeat(400)}`);
    expect(await withClaimLock([key], async () => "ok")).toBe("ok");
  });

  it("gives up after the lock timeout while a holder never commits", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let taken!: () => void;
    const lockTaken = new Promise<void>((r) => (taken = r));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${TASK_CLAIM_KEY}))`);
      taken();
      await held;
    });
    await lockTaken;
    const started = Date.now();
    let ran = false;
    try {
      // What a worker does: a null claim takes the re-queue-with-delay path.
      const claimed = await withClaimLock([TASK_CLAIM_KEY], async () => {
        ran = true;
        return "claimed";
      });
      const waited = Date.now() - started;
      expect(claimed).toBeNull();
      expect(ran).toBe(false);
      expect(waited).toBeGreaterThanOrEqual(9_500);
      expect(waited).toBeLessThan(15_000);
    } finally {
      release();
      await holder;
    }
    // The lock is free again: the next claimer gets it at once.
    expect(await withClaimLock([TASK_CLAIM_KEY], async () => "claimed")).toBe("claimed");
  }, 30_000);

  it("two claimers that need the same two keys take them in one order (no deadlock)", async () => {
    const a = withClaimLock(["claim:x", "claim:y"], async () => {
      await sleep(50);
      return "a";
    });
    const b = withClaimLock(["claim:y", "claim:x"], async () => {
      await sleep(50);
      return "b";
    });
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
  });
});

describe("one of two callers", () => {
  it("a poller sweep runs on one instance while the other skips", async () => {
    let runs = 0;
    const sweep = async () => {
      runs++;
      await sleep(200);
      return "ran";
    };
    // Two instances (one process here, so two explicit holders: the same
    // holder re-acquiring is an extension, and BullMQ's concurrency of 1
    // keeps one instance from overlapping itself).
    const [a, b] = await Promise.all([
      underPollerLease("it-poller", sweep, "api-a:1"),
      underPollerLease("it-poller", sweep, "api-b:2"),
    ]);
    expect([a, b].filter((r) => r === "ran")).toHaveLength(1);
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect(runs).toBe(1);
    // Released: the next tick runs, on either instance.
    expect(await underPollerLease("it-poller", sweep, "api-b:2")).toBe("ran");
  });

  it("a ticket's sync claim lands once; a task-less claim can be released, a recorded one cannot until its task is gone", async () => {
    const id = `ISSUE-${randomUUID().slice(0, 8)}`;
    const repo = "https://github.com/it-org/tickets";
    const [a, b] = await Promise.all([
      claimTicketForSync("github", id, repo),
      claimTicketForSync("github", id, repo),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await claimTicketForSync("github", id, repo)).toBe(false);

    await releaseTicketClaim("github", id, repo);
    expect(await claimTicketForSync("github", id, repo)).toBe(true);
    const task = await insertTask({ repoUrl: repo });
    await recordTicketClaimTask("github", id, repo, task.id);
    await releaseTicketClaim("github", id, repo); // has a task: stays
    expect(await claimTicketForSync("github", id, repo)).toBe(false);

    // The task was deleted: the ticket may get a new one, once.
    await db.delete(tasks).where(eq(tasks.id, task.id));
    const [c, d] = await Promise.all([
      claimTicketForSync("github", id, repo),
      claimTicketForSync("github", id, repo),
    ]);
    expect([c, d].filter(Boolean)).toHaveLength(1);

    // A sweep that died between its claim and its task: taken over after ten minutes.
    await db.execute(sql`
      UPDATE "ticket_sync_claims" SET "created_at" = now() - interval '11 minutes'
      WHERE "ticket_external_id" = ${id}`);
    expect(await claimTicketForSync("github", id, repo)).toBe(true);
  });

  it("an inbound webhook delivery is claimed by one of two receivers", async () => {
    const delivery = randomUUID();
    const [a, b] = await Promise.all([
      claimInboundDelivery("github", delivery),
      claimInboundDelivery("github", delivery),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await claimInboundDelivery("gitlab", delivery)).toBe(true); // another source
  });

  it("a WebSocket upgrade token minted anywhere is consumed by exactly one of two upgrades", async () => {
    const [user] = await db
      .insert(users)
      .values({
        provider: "github",
        externalId: `ws-${randomUUID()}`,
        email: `ws-${randomUUID().slice(0, 8)}@it.test`,
        displayName: "WS user",
      })
      .returning();
    const token = await createWsToken(user.id);
    const [a, b] = await Promise.all([validateWsToken(token), validateWsToken(token)]);
    const winners = [a, b].filter((u) => u !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0].id).toBe(user.id);
    expect(await validateWsToken(token)).toBeNull();

    // Expiry is the database's clock: an expired row is refused (and spent).
    const late = await createWsToken(user.id);
    await db.execute(
      sql`UPDATE "ws_upgrade_tokens" SET "expires_at" = now() - interval '1 second'`,
    );
    expect(await validateWsToken(late)).toBeNull();
    const [{ left }] = await db.execute<{ left: number }>(
      sql`SELECT count(*)::int AS "left" FROM "ws_upgrade_tokens"`,
    );
    expect(Number(left)).toBe(0);
  });

  it("a due schedule trigger is advanced by one of two sweeps, and fires once", async () => {
    const workflow = await insertWorkflow();
    const seen = new Date(Date.now() - 60_000);
    const trigger = await insertWorkflowTrigger(workflow.id, {
      workflowId: workflow.id,
      targetType: "job",
      type: "schedule",
      config: { cronExpression: "0 0 1 1 *" },
      enabled: true,
      nextFireAt: seen,
    });
    const [a, b] = await Promise.all([
      advanceScheduleCas(trigger.id, "0 0 1 1 *", seen),
      advanceScheduleCas(trigger.id, "0 0 1 1 *", seen),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const after = await getTrigger(trigger.id);
    expect(after!.nextFireAt!.getTime()).toBeGreaterThan(Date.now());
    expect(after!.lastFiredAt).toBeNull();

    // Two whole sweeps overlapping on another due trigger: one run.
    const second = await insertWorkflowTrigger(workflow.id, {
      workflowId: workflow.id,
      targetType: "job",
      type: "schedule",
      config: { cronExpression: "0 0 1 1 *" },
      enabled: true,
      nextFireAt: seen,
    });
    const fired = await Promise.all([checkDueScheduleTriggers(), checkDueScheduleTriggers()]);
    expect(fired[0] + fired[1]).toBe(1);
    const runs = await db.select().from(workflowRuns).where(eq(workflowRuns.triggerId, second.id));
    expect(runs).toHaveLength(1);
  });
});

describe("two overlapping sweeps", () => {
  it("ticket sync creates one task per ticket", async () => {
    const repo = await insertRepo();
    await db.insert(ticketProviders).values({
      source: "linear",
      config: { repoUrl: repo.repoUrl },
      enabled: true,
      initialSyncAt: new Date(Date.now() - 60_000),
    });
    const externalId = `LIN-${randomUUID().slice(0, 6)}`;
    outside.tickets = [
      {
        externalId,
        source: "linear",
        title: "Fix the flaky test",
        body: "It flakes.",
        url: `https://linear.app/it/issue/${externalId}`,
        labels: ["optio"],
        metadata: {},
      },
    ];
    try {
      await Promise.all([syncAllTickets(), syncAllTickets()]);
      // And a third sweep later sees the task (or the claim) and skips.
      await syncAllTickets();
    } finally {
      outside.tickets = [];
    }
    const created = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.ticketSource, "linear"), eq(tasks.ticketExternalId, externalId)));
    expect(created).toHaveLength(1);
  });

  it("external PR review launches a new PR's review once, and relaunches it once", async () => {
    const repo = await insertRepo({ externalReviewMode: "on_pr_post", reviewEnabled: true });
    const pr = {
      url: `${repo.repoUrl}/pull/7`,
      number: 7,
      title: "Add the thing",
      headSha: "aaaa1111",
      draft: false,
      author: "alice",
      labels: [],
    };
    outside.prs = [pr];
    const reviewsOfPr = () => db.select().from(prReviews).where(eq(prReviews.prUrl, pr.url));
    const runsOf = (id: string) =>
      db.select().from(prReviewRuns).where(eq(prReviewRuns.prReviewId, id));
    try {
      await Promise.all([sweepExternalPrs(), sweepExternalPrs()]);
      const [review, ...more] = await reviewsOfPr();
      expect(more).toHaveLength(0);
      expect(await runsOf(review.id)).toHaveLength(1);

      // The review finished; new commits land; two sweeps see them.
      await db
        .update(prReviews)
        .set({ state: "ready", updatedAt: new Date() })
        .where(eq(prReviews.id, review.id));
      pr.headSha = "bbbb2222";
      await Promise.all([sweepExternalPrs(), sweepExternalPrs()]);
      expect(await reviewsOfPr()).toHaveLength(1);
      expect(await runsOf(review.id)).toHaveLength(2);
    } finally {
      outside.prs = [];
    }
  });
});

describe("PR review launches", () => {
  it("a person's launch relaunches the current review; a sweep's stale view does not", async () => {
    const repo = await insertRepo({ externalReviewMode: "on_request", reviewEnabled: true });
    const pr = {
      url: `${repo.repoUrl}/pull/8`,
      number: 8,
      title: "Another thing",
      headSha: "cccc3333",
      draft: false,
      author: "bob",
      labels: [],
    };
    outside.prs = [pr];
    const runsOf = (id: string) =>
      db.select().from(prReviewRuns).where(eq(prReviewRuns.prReviewId, id));
    try {
      const first = await launchPrReview({ prUrl: pr.url });
      const id = first.review.id;
      expect(await runsOf(id)).toHaveLength(1);

      // A sweep that decided on an older version of the review loses.
      const stale = await launchPrReview({
        prUrl: pr.url,
        origin: "auto",
        seenVersion: new Date(Date.now() - 60 * 60_000),
      });
      expect(stale).toMatchObject({ raced: true });
      expect(await runsOf(id)).toHaveLength(1);

      // A person's launch takes the review as it is now, whatever changed.
      await db
        .update(prReviews)
        .set({ state: "ready", updatedAt: new Date() })
        .where(eq(prReviews.id, id));
      const manual = await launchPrReview({ prUrl: pr.url });
      expect(manual).not.toHaveProperty("raced");
      expect(manual.review.id).toBe(id);
      expect(await runsOf(id)).toHaveLength(2);
    } finally {
      outside.prs = [];
    }
  });
});

describe("GitHub user token refresh across instances", () => {
  const ENV = ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"] as const;
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const tokenResponse = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  async function userWithTokenDueForRefresh(refreshToken: string): Promise<string> {
    const userId = randomUUID();
    // Expires in a minute: inside the refresh buffer, so it is refreshed.
    await storeUserGitHubTokens(userId, {
      accessToken: "ghu_old",
      refreshToken,
      expiresIn: 60,
    });
    process.env.GITHUB_APP_CLIENT_ID = "it-client";
    process.env.GITHUB_APP_CLIENT_SECRET = "it-secret";
    return userId;
  }

  it("two instances refreshing one user call GitHub once and keep the new tokens", async () => {
    const userId = await userWithTokenDueForRefresh("ghr_old");
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).refresh_token);
      await sleep(300);
      return tokenResponse({
        access_token: "ghu_new",
        refresh_token: "ghr_new",
        expires_in: 28800,
      });
    });

    const [a, b] = await Promise.all([
      refreshUserTokenLeased(userId, null, "api-a:1"),
      refreshUserTokenLeased(userId, null, "api-b:2"),
    ]);
    expect(sent).toEqual(["ghr_old"]);
    expect([a, b]).toEqual(["ghu_new", "ghu_new"]);
    expect(await retrieveSecret("GITHUB_USER_REFRESH_TOKEN", `user:${userId}`)).toBe("ghr_new");
    expect(await retrieveSecret("GITHUB_USER_ACCESS_TOKEN", `user:${userId}`)).toBe("ghu_new");
  });

  it("bad_refresh_token deletes the tokens only while the refresh token is the one used", async () => {
    // Refused, and nobody stored a newer one: the tokens go.
    const gone = await userWithTokenDueForRefresh("ghr_revoked");
    vi.stubGlobal("fetch", async () => tokenResponse({ error: "bad_refresh_token" }));
    expect(await refreshUserTokenLeased(gone, null, "api-a:1")).toBeNull();
    await expect(retrieveSecret("GITHUB_USER_REFRESH_TOKEN", `user:${gone}`)).rejects.toThrow(
      /not found/,
    );

    // Refused, but a newer token landed meanwhile (a refresh that outlived
    // its lease, then another instance's): the newer tokens stay.
    const kept = await userWithTokenDueForRefresh("ghr_stale");
    vi.stubGlobal("fetch", async () => {
      await storeUserGitHubTokens(kept, {
        accessToken: "ghu_rotated",
        refreshToken: "ghr_rotated",
        expiresIn: 28800,
      });
      return tokenResponse({ error: "bad_refresh_token" });
    });
    expect(await refreshUserTokenLeased(kept, null, "api-a:1")).toBeNull();
    expect(await retrieveSecret("GITHUB_USER_REFRESH_TOKEN", `user:${kept}`)).toBe("ghr_rotated");
  });
});

describe("repeat jobs are schedulers", () => {
  it("two instances registering leave one scheduler; an older build's repeatable is removed", async () => {
    const name = `it-repeat-${randomUUID().slice(0, 8)}`;
    const queue = new Queue(name, { ...getBullMQOptions() });
    try {
      // The queue name is not in the registry; the ids are, and the registry
      // is only consulted by name on cleanup — use repo-cleanup's ids here.
      const [idA, idB] = REPEAT_SCHEDULERS["repo-cleanup"];
      await Promise.all([
        scheduleRepeat(queue, idA, 60_000),
        scheduleRepeat(queue, idA, 60_000),
        scheduleRepeat(queue, idB, 30_000),
      ]);
      await scheduleRepeat(queue, idA, 60_000); // a third boot
      expect((await queue.getJobSchedulers()).map((s) => s.key).sort()).toEqual([idA, idB].sort());

      // What the previous build registered.
      await queue.add("health-check", {}, { repeat: { every: 60_000 } });
      expect(await queue.getRepeatableJobs()).toHaveLength(3);

      const removed = await removeLegacyRepeatables(queue, "repo-cleanup");
      expect(removed).toBe(1);
      expect((await queue.getRepeatableJobs()).map((s) => s.key).sort()).toEqual([idA, idB].sort());
    } finally {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
    }
  });
});
