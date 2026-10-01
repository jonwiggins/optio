/**
 * Creating and saving work from its attributes, against real tables: the
 * kind follows from the answers, a definition and its trigger land together
 * (or not at all), a save keeps the kind and moves the one trigger the form
 * edits, and every name / path clash says which one it was.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { WorkSpec } from "@optio/shared";
import { db } from "../db/client.js";
import {
  persistentAgents,
  tasks,
  users,
  workDefinitions,
  workflowRuns,
  workflowTriggers,
} from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  WorkError,
  createWork,
  deleteWork,
  getOwnDefinition,
  updateWork,
} from "./work-write-service.js";

afterAll(async () => {
  const [{ taskQueue }, { workflowRunQueue }, { reconcileQueue }, { getRedisClient }] =
    await Promise.all([
      import("../workers/task-worker.js"),
      import("../workers/workflow-worker.js"),
      import("./reconcile-queue.js"),
      import("./event-bus.js"),
    ]);
  await Promise.allSettled([
    taskQueue.close(),
    workflowRunQueue.close(),
    reconcileQueue.close(),
    getRedisClient().quit(),
  ]);
});

const uniq = () => randomBytes(4).toString("hex");

function spec(over: Partial<WorkSpec> = {}): WorkSpec {
  return {
    name: `work ${uniq()}`,
    when: { type: "manual" },
    where: { runTarget: "cluster" },
    who: { runtime: "claude-code" },
    what: { prompt: "do the thing" },
    then: "exits",
    ...over,
  };
}

const repo = () => ({
  runTarget: "cluster" as const,
  repoUrl: `https://github.com/acme/app-${uniq()}`,
  repoBranch: "main",
});

const triggersOf = (targetId: string) =>
  db.select().from(workflowTriggers).where(eq(workflowTriggers.targetId, targetId));

async function rejection(p: Promise<unknown>): Promise<WorkError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WorkError);
  return err as WorkError;
}

describe("createWork", () => {
  it("saves a scheduled Task and its schedule together, the kind derived from the answers", async () => {
    const ws = await insertWorkspace();
    const created = await createWork(
      spec({
        where: repo(),
        when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
        then: "until-merged",
        mergeWhenReady: false,
      }),
      { workspaceId: ws.id, userId: null, isAdmin: false },
    );
    expect(created.kind).toBe("repo-blueprint");
    expect(created.href).toBe(`/tasks/scheduled/${created.id}`);

    const [row] = await db.select().from(workDefinitions).where(eq(workDefinitions.id, created.id));
    expect(row).toMatchObject({
      kind: "repo-blueprint",
      workspaceId: ws.id,
      prompt: "do the thing",
      runTitle: null,
      agentType: "claude-code",
      repoBranch: "main",
      maxRetries: 3,
      autoResume: true,
      autoMerge: false,
    });
    const [trigger] = await triggersOf(created.id);
    expect(trigger).toMatchObject({ targetType: "task_config", type: "schedule" });
    expect(trigger.nextFireAt).toBeInstanceOf(Date);
  });

  it("starts a Job made for now, and saves one started by a trigger", async () => {
    const ws = await insertWorkspace();
    const now = await createWork(spec(), { workspaceId: ws.id, userId: null, isAdmin: false });
    expect(now.kind).toBe("standalone");
    expect(now.run?.href).toBe(`/jobs/${now.id}/runs/${now.run?.id}`);
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, now.run!.id));
    expect(run).toMatchObject({ workflowId: now.id, state: "queued" });

    const later = await createWork(
      spec({ when: { type: "webhook", config: { path: `hook-${uniq()}` } } }),
      { workspaceId: ws.id, userId: null, isAdmin: false },
    );
    expect(later.run).toBeUndefined();
    expect(
      await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, later.id)),
    ).toEqual([]);
    const [trigger] = await triggersOf(later.id);
    // Job triggers keep their legacy workflow_id link, so deleting the Job takes them.
    expect(trigger).toMatchObject({ targetType: "job", workflowId: later.id });
  });

  it("submits a one-off Task in line", async () => {
    const ws = await insertWorkspace();
    const created = await createWork(spec({ where: repo() }), {
      workspaceId: ws.id,
      userId: null,
      isAdmin: false,
    });
    expect(created.kind).toBe("repo-task");
    const [task] = await db.select().from(tasks).where(eq(tasks.id, created.id));
    expect(task).toMatchObject({ state: "queued", workspaceId: ws.id, agentType: "claude-code" });
  });

  it("leaves nothing behind when the trigger is rejected", async () => {
    const ws = await insertWorkspace();
    const path = `taken-${uniq()}`;
    await createWork(spec({ when: { type: "webhook", config: { path } } }), {
      workspaceId: ws.id,
      userId: null,
      isAdmin: false,
    });

    const name = `clash ${uniq()}`;
    const err = await rejection(
      createWork(spec({ name, when: { type: "webhook", config: { path } } }), {
        workspaceId: ws.id,
        userId: null,
        isAdmin: false,
      }),
    );
    expect(err).toMatchObject({ status: 409, details: "webhook_path_taken" });

    const bad = await rejection(
      createWork(spec({ name, when: { type: "schedule", config: {} } }), {
        workspaceId: ws.id,
        userId: null,
        isAdmin: false,
      }),
    );
    expect(bad.status).toBe(400);

    const left = await db
      .select()
      .from(workDefinitions)
      .where(and(eq(workDefinitions.workspaceId, ws.id), eq(workDefinitions.name, name)));
    expect(left).toEqual([]);
  });

  it("says a name is taken, per kind and workspace", async () => {
    const ws = await insertWorkspace();
    const when = { type: "schedule", config: { cronExpression: "0 9 * * *" } } as const;
    await createWork(spec({ name: "Nightly", when }), {
      workspaceId: ws.id,
      userId: null,
      isAdmin: false,
    });
    const err = await rejection(
      createWork(spec({ name: "Nightly", when }), {
        workspaceId: ws.id,
        userId: null,
        isAdmin: false,
      }),
    );
    expect(err).toMatchObject({ status: 409, details: "name_taken" });

    // A scheduled Task is its own namespace; another workspace is too.
    await createWork(spec({ name: "Nightly", when, where: repo() }), {
      workspaceId: ws.id,
      userId: null,
      isAdmin: false,
    });
    const other = await insertWorkspace();
    await createWork(spec({ name: "Nightly", when }), {
      workspaceId: other.id,
      userId: null,
      isAdmin: false,
    });
  });

  it("refuses answers that don't make sense together", async () => {
    const actor = { workspaceId: null, userId: null, isAdmin: false };
    expect((await rejection(createWork(spec({ what: { prompt: " " } }), actor))).message).toMatch(
      /needs a prompt/,
    );
    expect(
      (
        await rejection(
          createWork(
            spec({
              then: "waits-for-me",
              where: repo(),
              when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
            }),
            actor,
          ),
        )
      ).message,
    ).toMatch(/session can't be started by a trigger/);
    expect((await rejection(createWork(spec({ who: { runtime: null } }), actor))).message).toMatch(
      /needs an agent/,
    );
  });

  it("creates a persistent agent and its trigger, then wakes it", async () => {
    const ws = await insertWorkspace();
    const created = await createWork(
      spec({
        name: `Forge ${uniq()}`,
        then: "waits-for-messages",
        when: { type: "schedule", config: { cronExpression: "0 * * * *" } },
        agent: { podLifecycle: "on-demand" },
      }),
      { workspaceId: ws.id, userId: null, isAdmin: false },
    );
    expect(created.kind).toBe("persistent-agent");
    const [agent] = await db
      .select()
      .from(persistentAgents)
      .where(eq(persistentAgents.id, created.id));
    expect(agent).toMatchObject({
      initialPrompt: "do the thing",
      podLifecycle: "on-demand",
      workspaceId: ws.id,
    });
    expect(agent.slug).toMatch(/^forge-/);
    const [trigger] = await triggersOf(created.id);
    expect(trigger).toMatchObject({ targetType: "persistent_agent", type: "schedule" });
  });
});

describe("updateWork", () => {
  it("saves the row and moves the one trigger: patched in place, replaced, or removed", async () => {
    const ws = await insertWorkspace();
    const actor = { workspaceId: ws.id, userId: null, isAdmin: false };
    const path = `hook-${uniq()}`;
    const base = spec({ where: repo(), when: { type: "webhook", config: { path } } });
    const { id } = await createWork(base, actor);
    const [first] = await triggersOf(id);

    // Same type: the trigger keeps its id (a webhook its row, a schedule its id).
    const newPath = `hook-${uniq()}`;
    await updateWork(
      id,
      {
        ...base,
        what: { prompt: "do it better", runTitle: "Run {{x}}" },
        when: { type: "webhook", config: { path: newPath } },
      },
      actor,
    );
    const [patched] = await triggersOf(id);
    expect(patched.id).toBe(first.id);
    expect(patched.config).toEqual({ path: newPath });
    const [row] = await db.select().from(workDefinitions).where(eq(workDefinitions.id, id));
    expect(row).toMatchObject({ prompt: "do it better", runTitle: "Run {{x}}" });

    // Another type replaces it.
    await updateWork(
      id,
      { ...base, when: { type: "schedule", config: { cronExpression: "0 9 * * *" } } },
      actor,
    );
    const replaced = await triggersOf(id);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ type: "schedule" });
    expect(replaced[0].id).not.toBe(first.id);

    // Answers that leave out what the saved kind needs are refused, and nothing changes.
    const err = await rejection(
      updateWork(id, { ...base, where: { runTarget: "cluster" } }, actor),
    );
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/needs a repo/);
    expect((await triggersOf(id))[0].id).toBe(replaced[0].id);

    // "Now" reads as a one-off Task, but the saved scheduled Task stays one:
    // its trigger goes, and it runs when started by hand.
    const saved = await updateWork(id, { ...base, when: { type: "manual" } }, actor);
    expect(saved).toMatchObject({ kind: "repo-blueprint", id });
    expect(await triggersOf(id)).toHaveLength(0);
    const [kept] = await db.select().from(workDefinitions).where(eq(workDefinitions.id, id));
    expect(kept.kind).toBe("repo-blueprint");
  });

  it("only saves definitions the caller can see", async () => {
    const ws = await insertWorkspace();
    const other = await insertWorkspace();
    const base = spec({ when: { type: "schedule", config: { cronExpression: "0 9 * * *" } } });
    const { id } = await createWork(base, { workspaceId: ws.id, userId: null, isAdmin: false });
    const err = await rejection(
      updateWork(id, base, { workspaceId: other.id, userId: null, isAdmin: false }),
    );
    expect(err.status).toBe(404);
    expect(
      await getOwnDefinition(id, { workspaceId: other.id, userId: null, isAdmin: false }),
    ).toBeNull();
    expect(await deleteWork(id, { workspaceId: other.id, userId: null, isAdmin: false })).toBe(
      false,
    );
  });
});

describe("settings", () => {
  const settings = {
    mcpServers: { add: ["m1", "m1"], remove: [] },
    setupCommands: "  npm ci ",
    review: { enabled: true, trigger: "on_pr" as const },
    maxAutoResumes: 2,
  };

  it("stores what pod work changes, cleaned; PR follow-through only where a PR opens", async () => {
    const ws = await insertWorkspace();
    const actor = { workspaceId: ws.id, userId: null, isAdmin: false };

    const task = await createWork(spec({ where: repo(), settings }), actor);
    const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(taskRow.settings).toEqual({
      mcpServers: { add: ["m1"] },
      setupCommands: "npm ci",
      review: { enabled: true, trigger: "on_pr" },
      maxAutoResumes: 2,
    });

    // A Job opens no PR: only its environment is kept.
    const job = await createWork(
      spec({ when: { type: "schedule", config: { cronExpression: "0 9 * * *" } }, settings }),
      actor,
    );
    const [jobRow] = await db.select().from(workDefinitions).where(eq(workDefinitions.id, job.id));
    expect(jobRow.settings).toEqual({ mcpServers: { add: ["m1"] }, setupCommands: "npm ci" });

    // Settings that change nothing store nothing; a save can clear them.
    await updateWork(
      job.id,
      spec({
        name: jobRow.name,
        when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
        settings: { mcpServers: {} },
      }),
      actor,
    );
    const [cleared] = await db.select().from(workDefinitions).where(eq(workDefinitions.id, job.id));
    expect(cleared.settings).toBeNull();
  });

  it("copies a scheduled Task's settings into each task it spawns", async () => {
    const ws = await insertWorkspace();
    const actor = { workspaceId: ws.id, userId: null, isAdmin: false };
    const blueprint = await createWork(
      spec({
        where: repo(),
        when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
        settings: { cautiousMode: true },
      }),
      actor,
    );
    const { instantiateTask } = await import("./task-config-service.js");
    const spawned = await instantiateTask(blueprint.id);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, spawned.id));
    expect(row.settings).toEqual({ cautiousMode: true });
    expect(row.workId).toBe(blueprint.id);
  });

  it("keeps a webhook's signing secret when the work is saved", async () => {
    const ws = await insertWorkspace();
    const actor = { workspaceId: ws.id, userId: null, isAdmin: false };
    const path = `hook-${uniq()}`;
    const base = spec({ when: { type: "webhook", config: { path } } });
    const { id } = await createWork(base, actor);
    const [trigger] = await triggersOf(id);
    await db
      .update(workflowTriggers)
      .set({ config: { path, secret: "s3cret" } })
      .where(eq(workflowTriggers.id, trigger.id));

    await updateWork(id, { ...base, what: { prompt: "do it better" } }, actor);
    const [saved] = await triggersOf(id);
    expect(saved.config).toEqual({ path, secret: "s3cret" });
  });
});

describe("deleteWork", () => {
  it("deletes a Job with its triggers and runs", async () => {
    const ws = await insertWorkspace();
    const actor = { workspaceId: ws.id, userId: null, isAdmin: false };
    const { id, run } = await createWork(spec(), actor);
    await db
      .insert(workflowTriggers)
      .values({ targetType: "job", targetId: id, workflowId: id, type: "manual" });

    expect(await deleteWork(id, actor)).toBe(true);
    expect(await triggersOf(id)).toEqual([]);
    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id))).toEqual([]);
    expect(await deleteWork(id, actor)).toBe(false);
  });
});

describe("personal work", () => {
  async function person(label: string) {
    const [row] = await db
      .insert(users)
      .values({
        provider: "github",
        externalId: `${label}-${uniq()}`,
        email: `${label}-${uniq()}@example.com`,
        displayName: label,
      })
      .returning();
    return row;
  }

  it("is its owner's to change and delete; an admin may still delete it", async () => {
    const ws = await insertWorkspace();
    const me = await person("me");
    const teammate = await person("teammate");
    const mine = { workspaceId: ws.id, userId: me.id, isAdmin: false };
    const theirs = { workspaceId: ws.id, userId: teammate.id, isAdmin: false };
    const base = spec({
      when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
      owner: "me",
    });
    const { id } = await createWork(base, mine);
    const [row] = await db.select().from(workDefinitions).where(eq(workDefinitions.id, id));
    expect(row.ownerUserId).toBe(me.id);

    expect((await rejection(updateWork(id, base, theirs))).status).toBe(403);
    expect((await rejection(deleteWork(id, theirs))).status).toBe(403);
    expect(await deleteWork(id, { ...theirs, isAdmin: true })).toBe(true);
  });
});
