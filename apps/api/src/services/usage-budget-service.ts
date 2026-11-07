/** Budgets are admission controls over recorded usage, not provider billing caps.
 * Already-running work can finish. Unknown prices never erase measured tokens.
 * The same check holds all new work while a deployment admin has paused it
 * (agent-work-pause.ts): that answers first, for every workspace.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import { listUsageBudgets } from "./usage-service.js";
import { PAUSE_MESSAGE_PREFIX, agentWorkPauseHold } from "./agent-work-pause.js";

/** Whether `column` holds a message this check wrote (cleared once work is admitted). */
export function admissionHoldMessage(column: AnyPgColumn): SQL {
  return sql`(${column} LIKE 'Usage budget reached:%' OR ${column} LIKE ${PAUSE_MESSAGE_PREFIX + "%"})`;
}

export async function usageBudgetHold(scope: {
  workspaceId: string | null;
  ownerUserId?: string | null;
  workId?: string | null;
}): Promise<string | null> {
  const paused = await agentWorkPauseHold();
  if (paused) return paused;
  if (!scope.workspaceId) return null;
  const budgets = await listUsageBudgets(scope.workspaceId);
  const blocked = budgets.find(
    (b) =>
      b.enabled &&
      b.action === "pause_new" &&
      b.fraction >= 1 &&
      (b.subjectKind === "organization" ||
        (b.subjectKind === "person" && b.subjectId === scope.ownerUserId) ||
        (b.subjectKind === "work" && !scope.ownerUserId && b.subjectId === scope.workId)),
  );
  return blocked
    ? `Usage budget reached: ${blocked.name}. New work is paused until the monthly reset or an administrator updates the budget.`
    : null;
}

/** Match the ledger's attribution, including child tasks charged to their parent. */
/** How long held work waits before it checks its budget again (tests shorten it). */
export const BUDGET_RETRY_MS = Number(process.env.OPTIO_BUDGET_RETRY_MS) || 60_000;

export async function runBudgetHold(kind: "task" | "job" | "agent" | "review", id: string) {
  const paused = await agentWorkPauseHold();
  if (paused) return paused;
  const query =
    kind === "task" || kind === "job"
      ? sql`
    SELECT t.workspace_id,t.owner_user_id,COALESCE(p.work_id,p.id,t.work_id,t.id) AS work_id,
    CASE WHEN t.kind='standalone' THEN d.budget_usd END AS budget_usd,t.cost_usd
    FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_task_id LEFT JOIN work_definitions d ON d.id=t.work_id WHERE t.id=${id}::uuid`
      : kind === "agent"
        ? sql`SELECT workspace_id,owner_user_id,id AS work_id,NULL::text AS budget_usd,NULL::text AS cost_usd FROM persistent_agents WHERE id=${id}::uuid`
        : sql`SELECT p.workspace_id,NULL::uuid AS owner_user_id,p.id AS work_id,NULL::text AS budget_usd,NULL::text AS cost_usd FROM pr_review_runs r JOIN pr_reviews p ON p.id=r.pr_review_id WHERE r.id=${id}::uuid`;
  const [r] = await db.execute<{
    workspace_id: string | null;
    owner_user_id: string | null;
    work_id: string;
    budget_usd: string | null;
    cost_usd: string | null;
  }>(query);
  if (!r) return null;
  if (r.budget_usd != null && Number(r.cost_usd ?? 0) >= Number(r.budget_usd))
    return "Usage budget reached: this run has reached its per-run cost limit. Increase the Job budget to allow another attempt.";
  return usageBudgetHold({
    workspaceId: r.workspace_id,
    ownerUserId: r.owner_user_id,
    workId: r.work_id,
  });
}
