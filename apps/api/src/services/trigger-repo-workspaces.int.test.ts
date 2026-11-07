/**
 * A repo can be registered in several workspaces (`repos` is unique on
 * url + workspace). An event or a ticket for that repo belongs to every
 * workspace that registered it, so each of their triggers fires, and a
 * workspace that never registered it still gets nothing.
 */
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { workflowRuns } from "../db/schema.js";
import * as triggerService from "./trigger-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { workflowRunQueue } from "../workers/workflow-worker.js";
import { reconcileQueue } from "./reconcile-queue.js";
import { getRedisClient } from "./event-bus.js";
import {
  insertRepo,
  insertWorkflow,
  insertWorkflowTrigger,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";

afterAll(async () => {
  await Promise.allSettled([
    taskQueue.close(),
    workflowRunQueue.close(),
    reconcileQueue.close(),
    getRedisClient().quit(),
  ]);
});

/** One repo URL registered in workspaces A and B; C has never registered it. */
async function sharedRepo() {
  const a = await insertWorkspace();
  const b = await insertWorkspace();
  const c = await insertWorkspace();
  const suffix = Date.now().toString(36);
  const fullName = `it-org/shared-${suffix}`;
  const repoUrl = `https://github.com/${fullName}`;
  await insertRepo({ workspaceId: a.id, repoUrl, fullName });
  await insertRepo({ workspaceId: b.id, repoUrl, fullName });
  return { a, b, c, fullName, repoUrl };
}

async function dropRuns(ids: string[]) {
  if (ids.length > 0) await db.delete(workflowRuns).where(inArray(workflowRuns.id, ids));
}

describe("triggers for a repo registered in several workspaces", () => {
  it("a GitHub event fires the triggers of every workspace that registered the repo", async () => {
    const { fireEventTriggers, normalizeGitHubEvent } = await import("./event-trigger-service.js");
    const { a, b, c, fullName } = await sharedRepo();
    const triggerIn = async (workspaceId: string) => {
      const job = await insertWorkflow({ workspaceId });
      return triggerService.createTrigger({
        targetType: "job",
        targetId: job.id,
        type: "github",
        config: { events: ["pr_opened"], repos: [fullName] },
      });
    };
    const inA = await triggerIn(a.id);
    const inB = await triggerIn(b.id);
    const inC = await triggerIn(c.id);

    const fired = await fireEventTriggers(
      "github",
      normalizeGitHubEvent("pull_request", {
        action: "opened",
        repository: { full_name: fullName, html_url: `https://github.com/${fullName}` },
        pull_request: {
          number: 3,
          title: "feat: widgets",
          body: "",
          html_url: `https://github.com/${fullName}/pull/3`,
          user: { login: "alice" },
          head: { ref: "feat/widgets" },
          base: { ref: "main" },
        },
      })!,
    );
    const ids = fired.map((f) => f.triggerId);
    await dropRuns(fired.filter((f) => f.kind === "workflow_run").map((f) => f.id));

    expect(ids).toContain(inA.id);
    expect(ids).toContain(inB.id);
    expect(ids).not.toContain(inC.id);
  });

  it("a ticket for the repo fires the ticket triggers of every workspace that registered it", async () => {
    const { fireTicketTriggers } = await import("./trigger-dispatch.js");
    const { a, b, c, repoUrl } = await sharedRepo();
    const label = `shared-${Date.now().toString(36)}`;
    const triggerIn = async (workspaceId: string) => {
      const job = await insertWorkflow({ workspaceId });
      return insertWorkflowTrigger(job.id, {
        workflowId: job.id,
        targetType: "job",
        type: "ticket",
        config: { source: "github", labels: [label] },
      });
    };
    const inA = await triggerIn(a.id);
    const inB = await triggerIn(b.id);
    const inC = await triggerIn(c.id);

    const fired = await fireTicketTriggers(
      { source: "github", externalId: "it-org/shared#1", title: "Bug", labels: [label] },
      { repoUrl },
    );
    const ids = fired.map((f) => f.triggerId);
    await dropRuns(fired.filter((f) => f.kind === "workflow_run").map((f) => f.id));

    expect(ids).toContain(inA.id);
    expect(ids).toContain(inB.id);
    expect(ids).not.toContain(inC.id);
    // Nothing else of this test is left behind for the worker to pick up.
    const left = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, inA.workflowId!));
    expect(left).toEqual([]);
  });
});
