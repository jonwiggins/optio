/**
 * Integration tests for the unified Task layer (`unified-task-service.ts`) —
 * the polymorphic resolver/list behind /api/tasks — against a real per-file
 * database.
 *
 * Covers:
 *   - resolveAnyTaskById resolving rows from each backing table with the
 *     right `type` discriminator (tasks / task_configs / workflows, plus the
 *     fourth pr_reviews table the service actually checks), and null for an
 *     unknown UUID.
 *   - listUnifiedTasks returning all kinds tagged with `type`, and honoring
 *     the type filter and per-kind limit.
 *   - Workspace scoping semantics as implemented:
 *       resolver — a row is hidden only when BOTH the caller workspace and
 *       the row workspace are set and differ; rows with a null workspaceId
 *       are visible to every caller.
 *       list — a scoped list matches workspaceId exactly, so null-workspace
 *       rows are EXCLUDED (asymmetric with the resolver); a null caller
 *       workspace yields a fully unscoped list.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { prReviews } from "../db/schema.js";
import {
  insertTask,
  insertTaskConfig,
  insertWorkflow,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { listUnifiedTasks, resolveAnyTaskById, type ResolvedTask } from "./unified-task-service.js";

async function insertPrReview(overrides: Partial<typeof prReviews.$inferInsert> = {}) {
  const prNumber = Math.floor(Math.random() * 1_000_000);
  const [row] = await db
    .insert(prReviews)
    .values({
      prUrl: `https://github.com/it-org/it-repo/pull/${prNumber}`,
      prNumber,
      repoOwner: "it-org",
      repoName: "it-repo",
      repoUrl: "https://github.com/it-org/it-repo",
      headSha: "deadbeefcafe",
      ...overrides,
    })
    .returning();
  return row;
}

const idsOf = (resolved: ResolvedTask[]) => resolved.map((r) => r.data.id as string);

// Shared fixture rows — created once; every test only asserts membership /
// exclusion by id, so tests stay independent of each other's inserts.
let wsA: Awaited<ReturnType<typeof insertWorkspace>>;
let wsB: Awaited<ReturnType<typeof insertWorkspace>>;
let taskGlobal: Awaited<ReturnType<typeof insertTask>>;
let taskA: Awaited<ReturnType<typeof insertTask>>;
let taskB: Awaited<ReturnType<typeof insertTask>>;
let configGlobal: Awaited<ReturnType<typeof insertTaskConfig>>;
let configA: Awaited<ReturnType<typeof insertTaskConfig>>;
let workflowGlobal: Awaited<ReturnType<typeof insertWorkflow>>;
let workflowA: Awaited<ReturnType<typeof insertWorkflow>>;
let reviewGlobal: Awaited<ReturnType<typeof insertPrReview>>;
let reviewA: Awaited<ReturnType<typeof insertPrReview>>;

beforeAll(async () => {
  wsA = await insertWorkspace({ name: "unified ws A" });
  wsB = await insertWorkspace({ name: "unified ws B" });

  taskGlobal = await insertTask({ title: "unified global task" });
  taskA = await insertTask({ title: "unified ws-a task", workspaceId: wsA.id });
  taskB = await insertTask({ title: "unified ws-b task", workspaceId: wsB.id });

  configGlobal = await insertTaskConfig();
  configA = await insertTaskConfig({ workspaceId: wsA.id });

  workflowGlobal = await insertWorkflow();
  workflowA = await insertWorkflow({ workspaceId: wsA.id });

  reviewGlobal = await insertPrReview();
  reviewA = await insertPrReview({ workspaceId: wsA.id });
});

describe("resolveAnyTaskById", () => {
  it("resolves a tasks row as repo-task with the native row", async () => {
    const resolved = await resolveAnyTaskById(taskGlobal.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.type).toBe("repo-task");
    expect(resolved!.data.id).toBe(taskGlobal.id);
    expect(resolved!.data.title).toBe("unified global task");
    expect(resolved!.data.prompt).toBe(taskGlobal.prompt);
  });

  it("resolves a task_configs row as repo-blueprint", async () => {
    const resolved = await resolveAnyTaskById(configGlobal.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.type).toBe("repo-blueprint");
    expect(resolved!.data.id).toBe(configGlobal.id);
    expect(resolved!.data.name).toBe(configGlobal.name);
  });

  it("resolves a workflows row as standalone", async () => {
    const resolved = await resolveAnyTaskById(workflowGlobal.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.type).toBe("standalone");
    expect(resolved!.data.id).toBe(workflowGlobal.id);
    expect(resolved!.data.name).toBe(workflowGlobal.name);
  });

  it("resolves a pr_reviews row as pr-review (fourth backing table)", async () => {
    const resolved = await resolveAnyTaskById(reviewGlobal.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.type).toBe("pr-review");
    expect(resolved!.data.id).toBe(reviewGlobal.id);
    expect(resolved!.data.prUrl).toBe(reviewGlobal.prUrl);
  });

  it("returns null for a UUID that exists in no table", async () => {
    const resolved = await resolveAnyTaskById(randomUUID());
    expect(resolved).toBeNull();
  });

  it("hides rows owned by a different workspace, for every kind", async () => {
    expect(await resolveAnyTaskById(taskA.id, wsB.id)).toBeNull();
    expect(await resolveAnyTaskById(configA.id, wsB.id)).toBeNull();
    expect(await resolveAnyTaskById(workflowA.id, wsB.id)).toBeNull();
    expect(await resolveAnyTaskById(reviewA.id, wsB.id)).toBeNull();
  });

  it("resolves rows owned by the caller's own workspace", async () => {
    const task = await resolveAnyTaskById(taskA.id, wsA.id);
    expect(task?.type).toBe("repo-task");
    expect(task?.data.id).toBe(taskA.id);

    const config = await resolveAnyTaskById(configA.id, wsA.id);
    expect(config?.type).toBe("repo-blueprint");

    const workflow = await resolveAnyTaskById(workflowA.id, wsA.id);
    expect(workflow?.type).toBe("standalone");

    const review = await resolveAnyTaskById(reviewA.id, wsA.id);
    expect(review?.type).toBe("pr-review");
  });

  it("rows with a null workspaceId are visible to any workspace", async () => {
    // Actual behavior: the scope check only fires when BOTH sides are set.
    const resolved = await resolveAnyTaskById(taskGlobal.id, wsB.id);
    expect(resolved?.type).toBe("repo-task");
    expect(resolved?.data.id).toBe(taskGlobal.id);
  });

  it("a caller with no workspace sees workspace-owned rows (unscoped)", async () => {
    const withUndefined = await resolveAnyTaskById(taskA.id);
    expect(withUndefined?.data.id).toBe(taskA.id);

    const withNull = await resolveAnyTaskById(workflowA.id, null);
    expect(withNull?.type).toBe("standalone");
  });
});

describe("listUnifiedTasks", () => {
  it("with no type filter and null workspace, returns every kind tagged", async () => {
    const all = await listUnifiedTasks({ workspaceId: null });
    const byId = new Map(all.map((r) => [r.data.id as string, r.type]));

    expect(byId.get(taskGlobal.id)).toBe("repo-task");
    expect(byId.get(taskA.id)).toBe("repo-task");
    expect(byId.get(taskB.id)).toBe("repo-task");
    expect(byId.get(configGlobal.id)).toBe("repo-blueprint");
    expect(byId.get(configA.id)).toBe("repo-blueprint");
    expect(byId.get(workflowGlobal.id)).toBe("standalone");
    expect(byId.get(workflowA.id)).toBe("standalone");
    expect(byId.get(reviewGlobal.id)).toBe("pr-review");
    expect(byId.get(reviewA.id)).toBe("pr-review");
  });

  it("type=repo-task returns only tasks rows", async () => {
    const rows = await listUnifiedTasks({ type: "repo-task", workspaceId: null });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.type === "repo-task")).toBe(true);
    expect(idsOf(rows)).toContain(taskGlobal.id);
    expect(idsOf(rows)).not.toContain(configGlobal.id);
    expect(idsOf(rows)).not.toContain(workflowGlobal.id);
  });

  it("type=repo-blueprint returns only task_configs rows", async () => {
    const rows = await listUnifiedTasks({ type: "repo-blueprint", workspaceId: null });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.type === "repo-blueprint")).toBe(true);
    expect(idsOf(rows)).toContain(configGlobal.id);
    expect(idsOf(rows)).not.toContain(taskGlobal.id);
  });

  it("type=standalone returns only workflows rows", async () => {
    const rows = await listUnifiedTasks({ type: "standalone", workspaceId: null });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.type === "standalone")).toBe(true);
    expect(idsOf(rows)).toContain(workflowGlobal.id);
    expect(idsOf(rows)).not.toContain(taskGlobal.id);
  });

  it("type=pr-review returns only pr_reviews rows", async () => {
    const rows = await listUnifiedTasks({ type: "pr-review", workspaceId: null });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.type === "pr-review")).toBe(true);
    expect(idsOf(rows)).toContain(reviewGlobal.id);
    expect(idsOf(rows)).not.toContain(taskGlobal.id);
  });

  it("scoped list returns only rows with exactly that workspaceId", async () => {
    const rows = await listUnifiedTasks({ workspaceId: wsA.id });
    const ids = idsOf(rows);

    // wsA-owned rows of every kind are present.
    expect(ids).toContain(taskA.id);
    expect(ids).toContain(configA.id);
    expect(ids).toContain(workflowA.id);
    expect(ids).toContain(reviewA.id);

    // Other-workspace rows are invisible.
    expect(ids).not.toContain(taskB.id);

    // Actual behavior: null-workspace rows are excluded from a scoped list
    // (eq() match), even though the resolver would return them.
    expect(ids).not.toContain(taskGlobal.id);
    expect(ids).not.toContain(configGlobal.id);
    expect(ids).not.toContain(workflowGlobal.id);
    expect(ids).not.toContain(reviewGlobal.id);

    // And every returned row really belongs to wsA.
    expect(rows.every((r) => r.data.workspaceId === wsA.id)).toBe(true);
  });

  it("a workspace with no rows gets an empty list", async () => {
    const empty = await insertWorkspace({ name: "unified empty ws" });
    const rows = await listUnifiedTasks({ workspaceId: empty.id });
    expect(rows).toEqual([]);
  });

  it("limit caps each kind independently", async () => {
    // Three tasks rows exist; limit=1 with a type filter yields exactly one.
    const one = await listUnifiedTasks({ type: "repo-task", workspaceId: null, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0].type).toBe("repo-task");

    // Without a type filter the limit applies per kind, not to the merged
    // list: 1 task + 1 config + 1 workflow + 1 pr-review.
    const merged = await listUnifiedTasks({ workspaceId: null, limit: 1 });
    expect(merged).toHaveLength(4);
    expect(merged.map((r) => r.type).sort()).toEqual([
      "pr-review",
      "repo-blueprint",
      "repo-task",
      "standalone",
    ]);
  });
});
