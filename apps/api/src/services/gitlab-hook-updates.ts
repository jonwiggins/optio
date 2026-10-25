/**
 * What a GitLab project hook tells Optio about its own work, the way the
 * GitHub webhook does (routes/tickets.ts): an issue that gets the ticket
 * label syncs tickets at once, and a merge request that merged completes its
 * task at once. Any other merge request, pipeline or comment event on a
 * task's MR wakes the reconciler for that task, so the task follows GitLab
 * within seconds rather than at the PR watcher's next poll.
 *
 * Everything here is idempotent (a redelivery syncs or wakes again), and the
 * ticket sync runs in the background: GitLab gives a hook 10 seconds and
 * disables one that keeps timing out.
 */
import { DEFAULT_TICKET_LABEL, TaskState } from "@optio/shared";
import { logger } from "../logger.js";

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

/** Label titles from a hook's `labels` / `changes.labels.*` (objects or strings). */
function labelTitles(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((l) => (typeof l === "string" ? l : obj(l).title))
    .filter((t): t is string => typeof t === "string");
}

let ticketSync: Promise<unknown> | null = null;

/** One ticket sync at a time; a hook during a sync is covered by it. */
function syncTicketsSoon(): void {
  if (ticketSync) return;
  ticketSync = import("./ticket-sync-service.js")
    .then(({ syncAllTickets }) => syncAllTickets())
    .catch((err) => logger.warn({ err }, "Ticket sync after a GitLab issue hook failed"))
    .finally(() => {
      ticketSync = null;
    });
}

/** Whether an issue hook says the issue just got the ticket label (or opened with it). */
export function issueGotTicketLabel(body: unknown, label = DEFAULT_TICKET_LABEL): boolean {
  const b = obj(body);
  const kind = b.object_kind;
  if (kind !== "issue" && kind !== "work_item") return false;
  const change = obj(obj(b.changes).labels);
  if (Object.keys(change).length > 0) {
    return (
      labelTitles(change.current).includes(label) && !labelTitles(change.previous).includes(label)
    );
  }
  return obj(b.object_attributes).action === "open" && labelTitles(b.labels).includes(label);
}

/** The merge request URL a merge request, pipeline or note hook is about, if any. */
export function hookMergeRequestUrl(body: unknown): string | null {
  const b = obj(body);
  const url =
    b.object_kind === "merge_request" ? obj(b.object_attributes).url : obj(b.merge_request).url;
  return typeof url === "string" && url ? url : null;
}

export async function applyGitLabHookUpdates(body: unknown): Promise<void> {
  const b = obj(body);
  if (issueGotTicketLabel(b)) {
    logger.info({ issue: obj(b.object_attributes).iid }, "GitLab issue labeled for Optio");
    syncTicketsSoon();
    return;
  }

  const kind = b.object_kind;
  if (kind !== "merge_request" && kind !== "pipeline" && kind !== "note") return;
  const mrUrl = hookMergeRequestUrl(b);
  if (!mrUrl) return;
  const taskService = await import("./task-service.js");
  const task = await taskService.getTaskByPrUrl(mrUrl);
  if (!task) return;

  const action = kind === "merge_request" ? String(obj(b.object_attributes).action ?? "") : "";
  if (action === "merge") {
    try {
      await taskService.transitionTask(task.id, TaskState.COMPLETED, "pr_merged", mrUrl);
      logger.info({ taskId: task.id, mrUrl }, "Task completed via MR merge");
      return;
    } catch {
      // Already completed, or not in a state that completes: the reconciler decides.
    }
  }
  const { enqueueReconcile } = await import("./reconcile-queue.js");
  await enqueueReconcile(
    { kind: "repo", id: task.id },
    { reason: `gitlab_hook:${kind}${action ? `:${action}` : ""}` },
  );
}
