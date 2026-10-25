import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { prReviews, tasks, workDefinitions } from "../db/schema.js";
import type { Actor } from "./ownership.js";
import type { UnifiedTaskType } from "./unified-task-service.js";
import { visibleWork } from "./work-visibility.js";

/**
 * `countUnifiedTasks` (unified-task-service.ts) counted for one viewer: the
 * `total` of `GET /api/tasks?type=` counts the rows `listUnifiedTasks` may
 * show them (work-visibility.ts), not the workspace's every row. PR reviews
 * have no owner and are counted as that list shows them, per workspace.
 * Without a viewer, or for an admin, it is upstream's count.
 */
export async function countVisibleUnifiedTasks(opts: {
  type?: UnifiedTaskType;
  workspaceId?: string | null;
  viewer?: Actor;
}): Promise<number> {
  const wsId = opts.workspaceId ?? null;
  const count = async (
    table: typeof tasks | typeof workDefinitions | typeof prReviews,
    where: SQL | undefined,
  ) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(where);
    return row?.n ?? 0;
  };
  const visibleTasks = opts.viewer
    ? visibleWork(tasks.ownerUserId, tasks.ownerTeamId, tasks.createdBy, opts.viewer)
    : undefined;
  const visibleDefinitions = opts.viewer
    ? visibleWork(
        workDefinitions.ownerUserId,
        workDefinitions.ownerTeamId,
        workDefinitions.createdBy,
        opts.viewer,
      )
    : undefined;
  const definitionsOf = (kind: "repo-blueprint" | "standalone") =>
    count(
      workDefinitions,
      and(
        eq(workDefinitions.kind, kind),
        wsId ? eq(workDefinitions.workspaceId, wsId) : undefined,
        visibleDefinitions,
      ),
    );
  let total = 0;
  if (!opts.type || opts.type === "repo-task")
    total += await count(tasks, and(wsId ? eq(tasks.workspaceId, wsId) : undefined, visibleTasks));
  if (!opts.type || opts.type === "repo-blueprint") total += await definitionsOf("repo-blueprint");
  if (!opts.type || opts.type === "standalone") total += await definitionsOf("standalone");
  if (!opts.type || opts.type === "pr-review")
    total += await count(prReviews, wsId ? eq(prReviews.workspaceId, wsId) : undefined);
  return total;
}
