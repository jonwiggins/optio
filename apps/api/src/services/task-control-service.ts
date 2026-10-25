/** Shared by the HTTP controls and MCP; authorization belongs to the caller. */
import { TaskState } from "@optio/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { rebaseTarget } from "./resume-prompts.js";

export class TaskControlError extends Error {
  readonly status = 409;
}
export type TaskControl = "cancel" | "retry" | "resume" | "restart" | "redo" | "run-now";
export async function controlTask(
  id: string,
  action: TaskControl,
  opts: {
    prompt?: string;
    userId?: string;
    task?: NonNullable<Awaited<ReturnType<typeof taskService.getTask>>>;
  } = {},
) {
  const task = opts.task ?? (await taskService.getTask(id));
  if (!task) throw new TaskControlError("Task not found");
  if (action === "cancel")
    return taskService.transitionTask(
      id,
      TaskState.CANCELLED,
      "user_cancel",
      undefined,
      opts.userId,
    );
  if (action === "resume" && !["needs_attention", "failed"].includes(task.state))
    throw new TaskControlError(`Cannot resume task in ${task.state} state`);
  if (action === "restart" && !["needs_attention", "failed", "pr_opened"].includes(task.state))
    throw new TaskControlError(`Cannot force-restart task in ${task.state} state`);
  if (action === "run-now" && task.state !== "queued")
    throw new TaskControlError("Task is not in queued state");
  if (action === "redo" || action === "run-now") {
    const pending = await taskQueue.getJobs(["waiting", "delayed", "prioritized"]);
    for (const job of pending) if (job.data?.taskId === id) await job.remove().catch(() => {});
  }
  let updated;
  let data: Parameters<typeof taskQueue.add>[1] = { taskId: id };
  if (action === "redo") updated = await taskService.forceRedoTask(id);
  else if (action === "run-now") {
    await db
      .update(tasks)
      .set({ ignoreOffPeak: true, updatedAt: new Date() })
      .where(eq(tasks.id, id));
  } else if (action === "retry") {
    if (task.state === "queued") {
      // Already waiting its turn (queued → queued is no transition): a job
      // in the queue means there is nothing to do; without one — the queue
      // lost it — the job is added again below, with no state write.
      const pending = await taskQueue.getJobs(["waiting", "delayed", "prioritized", "active"]);
      if (pending.some((job) => job.data?.taskId === id)) return task;
      if (task.prUrl) data = { ...data, restartFromBranch: true };
    } else if (task.state === "pending" || task.state === "waiting_on_deps") {
      throw new TaskControlError(
        `Task has not started yet (${task.state.replace(/_/g, " ")}); start it instead`,
      );
    } else {
      updated = await taskService.transitionTask(
        id,
        TaskState.QUEUED,
        "user_retry",
        undefined,
        opts.userId,
      );
      if (task.prUrl) data = { ...data, restartFromBranch: true };
    }
  } else if (action === "resume") {
    await taskService.transitionTask(id, TaskState.QUEUED, "user_resume", opts.prompt);
    data = {
      ...data,
      resumeSessionId: task.sessionId,
      resumePrompt: opts.prompt ?? "Continue working on this task.",
    };
  } else {
    const prompt = opts.prompt ?? buildRestartPrompt(task);
    await taskService.transitionTask(id, TaskState.QUEUED, "force_restart", prompt.slice(0, 200));
    data = { ...data, resumePrompt: prompt, restartFromBranch: !!task.prUrl };
  }
  // A lost job's re-add (retry of a queued task) is named after the queued
  // row, so retries that race past the queue check above add one job.
  const requeued = action === "retry" && task.state === "queued";
  await taskQueue.add("process-task", data, {
    jobId: requeued
      ? `${id}-requeue-${task.updatedAt ? new Date(task.updatedAt).getTime() : 0}`
      : `${id}-${action === "run-now" ? "runnow" : action}-${Date.now()}`,
    ...(action === "run-now" ? { priority: task.priority ?? 100 } : { attempts: 1 }),
  });
  return updated ?? taskService.getTask(id);
}

function buildRestartPrompt(task: {
  repoBranch?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prChecksStatus?: string | null;
  prReviewStatus?: string | null;
  prReviewComments?: string | null;
  errorMessage?: string | null;
}): string {
  const parts: string[] = [];

  if (task.prUrl) {
    parts.push(`You have an existing PR (${task.prUrl}) on this branch. Do NOT create a new PR.`);
  }

  if (task.prChecksStatus === "conflicts") {
    parts.push(
      // Onto the task's own branch, not a fixed origin/main (resume-facts.ts).
      `Your PR has merge conflicts with the base branch. Please:\n1. Run \`git fetch origin && git rebase ${rebaseTarget(task.repoBranch || "main")}\`\n2. Resolve any conflicts\n3. Run the tests to make sure everything still works\n4. Force-push: \`git push --force-with-lease\``,
    );
  } else if (task.prChecksStatus === "failing") {
    parts.push(
      "CI checks are failing on the PR. Investigate the failures, fix the issues, and push.",
    );
  }

  if (task.prReviewStatus === "changes_requested" && task.prReviewComments) {
    parts.push(
      `A reviewer requested changes:\n\n${task.prReviewComments}\n\nPlease address this feedback.`,
    );
  }

  if (task.errorMessage) {
    parts.push(`The previous run failed with: ${task.errorMessage}`);
  }

  if (parts.length === 0) {
    parts.push("Continue working on this task. Review the current state and fix any issues.");
  }

  return parts.join("\n\n");
}
