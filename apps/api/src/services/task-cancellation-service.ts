import { logger } from "../logger.js";

/**
 * Task cancellation — actually stops the agent when a task is cancelled.
 *
 * Historically, cancelling a task was a pure DB state flip: the task showed
 * as `cancelled` in the UI while the agent process kept running inside the
 * repo pod, burning tokens and even opening PRs afterwards (#549). This
 * module closes that gap with two mechanisms:
 *
 *  1. An in-process registry of live exec sessions. The task worker
 *     registers each task's ExecSession while the agent is streaming;
 *     cancellation closes it, which severs the k8s exec WebSocket and ends
 *     the worker's stdout loop immediately.
 *  2. A best-effort in-pod kill via `killOrphanedAgentInPod`, which
 *     TERM-then-KILLs every process whose environment carries
 *     `OPTIO_TASK_ID=<taskId>` (exported by the exec script), then removes
 *     the task's worktree.
 *
 * All workers run in the same API process (see `apps/api/src/index.ts`), so
 * the in-memory registry is visible to every cancellation entry point
 * (cancel route, reconciler control-intent) via
 * `taskService.transitionTask`, which invokes `terminateTaskExecution`
 * whenever a task enters the cancelled state from running.
 *
 * Kept in its own module (rather than task-service) and using lazy imports
 * for collaborators so there is no static dependency cycle between
 * task-service, repo-pool-service, and the task worker.
 */

interface ClosableExec {
  close: () => void;
}

const activeExecSessions = new Map<string, ClosableExec>();

/** Track a live exec session for a task so cancellation can abort it. */
export function registerActiveExec(taskId: string, session: ClosableExec): void {
  activeExecSessions.set(taskId, session);
}

/** Remove a task's exec session from the registry without closing it. */
export function unregisterActiveExec(taskId: string): void {
  activeExecSessions.delete(taskId);
}

/**
 * Close and forget the exec session for a task, if one is live in this
 * process. Returns true if a session was found and closed.
 */
export function abortActiveExec(taskId: string): boolean {
  const session = activeExecSessions.get(taskId);
  if (!session) return false;
  activeExecSessions.delete(taskId);
  try {
    session.close();
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to close exec session for cancelled task");
  }
  return true;
}

/** Number of live exec sessions (exported for tests/diagnostics). */
export function activeExecCount(): number {
  return activeExecSessions.size;
}

/**
 * Terminate a cancelled task's execution:
 *  - abort the server-side exec/log stream (unblocks the worker loop), and
 *  - kill the agent process inside the repo pod, cleaning up its worktree.
 *
 * Best-effort: failures are logged, never thrown — the task is already
 * cancelled in the DB and post-exec paths are guarded on task state.
 */
export async function terminateTaskExecution(
  taskId: string,
): Promise<{ streamAborted: boolean; agentKilled: boolean }> {
  const streamAborted = abortActiveExec(taskId);
  let agentKilled = false;

  try {
    const taskService = await import("./task-service.js");
    const repoPool = await import("./repo-pool-service.js");

    const task = await taskService.getTask(taskId);
    const podId = task?.lastPodId;
    if (podId) {
      agentKilled = await repoPool.killOrphanedAgentInPod(podId, taskId);
      await repoPool.updateWorktreeState(taskId, "removed");
    }
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to kill in-pod agent for cancelled task");
  }

  logger.info({ taskId, streamAborted, agentKilled }, "Terminated execution for cancelled task");
  return { streamAborted, agentKilled };
}
