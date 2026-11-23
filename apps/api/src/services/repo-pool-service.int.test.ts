import { sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { agentPods, tasks } from "../db/schema.js";
import { getPod } from "./agent-pod-pool.js";
import { reconcileActiveTaskCounts } from "./repo-pool-service.js";

async function repoPod() {
  const [row] = await db
    .insert(agentPods)
    .values({
      isolationKey: "test-boundary",
      pool: "repo",
      poolKey: `https://github.com/example/repo-${Math.random()}`,
      state: "ready",
      podName: `pod-${Math.random().toString(36).slice(2, 8)}`,
      activeCount: 1,
    })
    .returning();
  return row;
}

async function task(podId: string, over: Partial<PgInsertValue<typeof tasks>>) {
  await db.insert(tasks).values({
    title: "t",
    prompt: "p",
    repoUrl: "https://github.com/example/repo",
    agentType: "claude-code",
    lastPodId: podId,
    ...over,
  });
}

describe("reconcileActiveTaskCounts", () => {
  it("keeps a pod busy while its agent is still streamed from a pr_opened task", async () => {
    const pod = await repoPod();
    await task(pod.id, {
      state: "pr_opened",
      attachedBy: "api-1",
      attachLeaseUntil: sql`now() + interval '60 seconds'`,
      lastActivityAt: sql`now()`,
    });

    await reconcileActiveTaskCounts();

    expect((await getPod(pod.id))!.activeCount).toBe(1);
  });

  it("frees a pod whose attached pr_opened agent has been silent past the stall threshold", async () => {
    const pod = await repoPod();
    await task(pod.id, {
      state: "pr_opened",
      attachedBy: "api-1",
      attachLeaseUntil: sql`now() + interval '60 seconds'`,
      lastActivityAt: sql`now() - interval '1 day'`,
    });

    await reconcileActiveTaskCounts();

    expect((await getPod(pod.id))!.activeCount).toBe(0);
  });

  it("frees a pod whose non-running task has no live attachment", async () => {
    const pod = await repoPod();
    await task(pod.id, {
      state: "pr_opened",
      attachLeaseUntil: sql`now() - interval '60 seconds'`,
    });

    await reconcileActiveTaskCounts();

    expect((await getPod(pod.id))!.activeCount).toBe(0);
  });
});
