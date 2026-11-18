import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentPods, prReviewRuns, prReviews, tasks } from "../db/schema.js";
import { insertTask } from "../test-utils/integration/fixtures.js";
import { idlePods } from "./agent-pod-pool.js";
import { reconcileActiveTaskCounts } from "./repo-pool-service.js";

const old = () => new Date(Date.now() - 20 * 60_000);

async function reviewPod(activeCount: number) {
  const [pod] = await db
    .insert(agentPods)
    .values({
      pool: "repo",
      poolKey: "https://github.com/test/review-counts",
      isolationKey: "review-counts",
      state: "ready",
      podName: "test-review-pod",
      activeCount,
      updatedAt: old(),
    })
    .returning();
  const [review] = await db
    .insert(prReviews)
    .values({
      prUrl: "https://github.com/test/review-counts/pull/1",
      prNumber: 1,
      repoOwner: "test",
      repoName: "review-counts",
      repoUrl: pod.poolKey,
      headSha: "a".repeat(40),
      state: "reviewing",
    })
    .returning();
  return { pod, review };
}

afterEach(async () => {
  await db.delete(prReviews);
  await db.delete(tasks);
  await db.delete(agentPods);
});

describe("repo pod liveness with PR reviews", () => {
  it("counts active tasks and reviews while ignoring queued and terminal reviews", async () => {
    const { pod, review } = await reviewPod(0);
    await insertTask({ state: "running", lastPodId: pod.id });
    await db
      .insert(prReviewRuns)
      .values(
        (["queued", "provisioning", "running", "completed", "failed", "cancelled"] as const).map(
          (state) => ({ prReviewId: review.id, podId: pod.id, state }),
        ),
      );
    await db.insert(prReviewRuns).values({ prReviewId: review.id, state: "running" });

    await reconcileActiveTaskCounts();

    const [counted] = await db.select().from(agentPods).where(eq(agentPods.id, pod.id));
    expect(counted.activeCount).toBe(3);
  });

  it.each(["provisioning", "running"] as const)(
    "keeps a %s review's pod out of idle cleanup even with a stale zero counter",
    async (state) => {
      const { pod, review } = await reviewPod(0);
      await db.insert(prReviewRuns).values({ prReviewId: review.id, podId: pod.id, state });

      expect(await idlePods("repo", new Date(Date.now() - 10 * 60_000))).toEqual([]);
    },
  );

  it("allows the idle pod to be reclaimed after its review finishes", async () => {
    const { pod, review } = await reviewPod(1);
    await db
      .insert(prReviewRuns)
      .values({ prReviewId: review.id, podId: pod.id, state: "completed" });

    await reconcileActiveTaskCounts();
    await db.update(agentPods).set({ updatedAt: old() }).where(eq(agentPods.id, pod.id));

    expect(await idlePods("repo", new Date(Date.now() - 10 * 60_000))).toMatchObject([
      { id: pod.id, activeCount: 0 },
    ]);
  });
});
