/**
 * task_prs against real Postgres: adopting several PRs per task (the first
 * becomes tasks.pr_url), the primary's row from updateTaskPr, attaching and
 * removing by hand, and the personal-work ownership guard on the routes.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// No git platform in this tier: lookups fall back to the URL alone.
vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: vi.fn().mockRejectedValue(new Error("no token in tests")),
}));

import { db } from "../db/client.js";
import { taskPrs, tasks, users } from "../db/schema.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { taskRoutes } from "../routes/tasks.js";
import * as taskService from "./task-service.js";
import {
  adoptTaskPrs,
  attachTaskPr,
  listTaskPrs,
  removeTaskPr,
  TaskPrError,
  type ConfirmedPr,
} from "./task-pr-service.js";

const REPO = "https://github.com/it-org/multi-pr";

function confirmed(n: number, over: Partial<ConfirmedPr> = {}): ConfirmedPr {
  return {
    url: `${REPO}/pull/${n}`,
    number: n,
    headBranch: `optio/task-x-${n}`,
    headRepo: "it-org/multi-pr",
    baseBranch: "main",
    state: "open",
    source: "tool_call",
    ...over,
  };
}

async function reload(id: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row;
}

async function insertUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(4).toString("hex")}`,
      email: `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@prs.it`,
      displayName: name,
    })
    .returning();
  return row;
}

describe("task_prs", () => {
  it("records every PR a task opened; the first becomes the primary", async () => {
    const task = await insertTask({ repoUrl: REPO, state: "running" });
    const first = await adoptTaskPrs(task.id, [confirmed(1), confirmed(2, { source: "branch" })]);
    expect(first.primaryUrl).toBe(`${REPO}/pull/1`);
    expect((await reload(task.id)).prUrl).toBe(`${REPO}/pull/1`);
    expect((await reload(task.id)).prNumber).toBe(1);

    // A later run's PR is tracked alongside; the primary stays.
    const again = await adoptTaskPrs(task.id, [confirmed(3), confirmed(1, { state: "merged" })]);
    expect(again.primaryUrl).toBe(`${REPO}/pull/1`);

    const prs = await listTaskPrs(await reload(task.id));
    expect(prs.map((p) => [p.number, p.primary, p.source])).toEqual([
      [1, true, "tool_call"],
      [2, false, "branch"],
      [3, false, "tool_call"],
    ]);
    // Re-sighting a PR refreshes it (one row per task + url).
    const rows = await db.select().from(taskPrs).where(eq(taskPrs.taskId, task.id));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.number === 1)?.state).toBe("merged");
  });

  it("a cancelled task adopts nothing", async () => {
    const task = await insertTask({ repoUrl: REPO, state: "cancelled" });
    const res = await adoptTaskPrs(task.id, [confirmed(4)]);
    expect(res.adopted).toEqual([]);
    expect((await reload(task.id)).prUrl).toBeNull();
    expect(await db.select().from(taskPrs).where(eq(taskPrs.taskId, task.id))).toEqual([]);
  });

  it("updateTaskPr also tracks the primary in task_prs (GitLab numbers too)", async () => {
    const task = await insertTask({ repoUrl: "https://gitlab.com/g/r", state: "running" });
    await taskService.updateTaskPr(task.id, "https://gitlab.com/g/r/-/merge_requests/7");
    expect((await reload(task.id)).prNumber).toBe(7);
    const prs = await listTaskPrs(await reload(task.id));
    expect(prs).toEqual([
      expect.objectContaining({ number: 7, primary: true, source: "branch", state: "open" }),
    ]);
  });

  it("attaches a PR in the task's repo and refuses others", async () => {
    const task = await insertTask({ repoUrl: REPO, state: "pr_opened", prUrl: null });
    await expect(attachTaskPr(task, "https://github.com/other/repo/pull/1")).rejects.toThrow(
      TaskPrError,
    );
    await expect(attachTaskPr(task, "not a url")).rejects.toThrow(TaskPrError);
    const pr = await attachTaskPr(task, `${REPO}/pull/9`);
    expect(pr).toMatchObject({ number: 9, source: "attached", primary: true });
    expect((await reload(task.id)).prUrl).toBe(`${REPO}/pull/9`);
  });

  it("removes a PR; the primary only when another can take its place", async () => {
    const task = await insertTask({ repoUrl: REPO, state: "pr_opened" });
    await adoptTaskPrs(task.id, [confirmed(10)]);
    let prs = await listTaskPrs(await reload(task.id));
    const err = await removeTaskPr(await reload(task.id), prs[0].id).catch((e) => e);
    expect(err).toBeInstanceOf(TaskPrError);
    expect(err.status).toBe(409);

    await adoptTaskPrs(task.id, [confirmed(11)]);
    prs = await listTaskPrs(await reload(task.id));
    const { primaryUrl } = await removeTaskPr(await reload(task.id), prs[0].id);
    expect(primaryUrl).toBe(`${REPO}/pull/11`);
    const after = await reload(task.id);
    expect(after.prUrl).toBe(`${REPO}/pull/11`);
    expect(after.prNumber).toBe(11);
    expect((await listTaskPrs(after)).map((p) => [p.number, p.primary])).toEqual([[11, true]]);

    await expect(removeTaskPr(after, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject(
      { status: 404 },
    );
  });

  it("only the owner can attach / remove PRs on personal work", async () => {
    const ws = await insertWorkspace();
    const owner = await insertUser("Owner");
    const other = await insertUser("Other");
    const task = await insertTask({
      repoUrl: REPO,
      state: "pr_opened",
      workspaceId: ws.id,
      ownerUserId: owner.id,
    });
    await adoptTaskPrs(task.id, [confirmed(20), confirmed(21)]);
    const [, extra] = await listTaskPrs(await reload(task.id));

    const asOther = await buildRouteTestApp(taskRoutes, {
      user: { id: other.id, workspaceId: ws.id, workspaceRole: "admin" },
    });
    const attach = await asOther.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/prs`,
      payload: { url: `${REPO}/pull/22` },
    });
    expect(attach.statusCode).toBe(403);
    expect(attach.json().error).toContain("Owner");
    const del = await asOther.inject({
      method: "DELETE",
      url: `/api/tasks/${task.id}/prs/${extra.id}`,
    });
    expect(del.statusCode).toBe(403);
    await asOther.close();

    const asOwner = await buildRouteTestApp(taskRoutes, {
      user: { id: owner.id, workspaceId: ws.id, workspaceRole: "member" },
    });
    const ok = await asOwner.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/prs`,
      payload: { url: `${REPO}/pull/22` },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().pr).toMatchObject({ number: 22, primary: false });
    const removed = await asOwner.inject({
      method: "DELETE",
      url: `/api/tasks/${task.id}/prs/${extra.id}`,
    });
    expect(removed.statusCode).toBe(200);
    const detail = await asOwner.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(detail.json().task.prs.map((p: { number: number }) => p.number)).toEqual([20, 22]);
    await asOwner.close();
  });
});
