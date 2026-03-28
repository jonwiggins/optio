import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { TaskState } from "@optio/shared";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { logger } from "../logger.js";

export interface SubtaskInput {
  parentTaskId: string;
  title: string;
  prompt: string;
  taskType?: string; // "review" | "step" | "child"
  blocksParent?: boolean;
  agentType?: string;
  priority?: number;
}

/**
 * Create a subtask linked to a parent task.
 */
export async function createSubtask(input: SubtaskInput) {
  const parent = await taskService.getTask(input.parentTaskId);
  if (!parent) throw new Error("Parent task not found");

  // Get next subtask order
  const [maxOrder] = await db
    .select({ max: sql<number>`COALESCE(MAX(${tasks.subtaskOrder}), -1)` })
    .from(tasks)
    .where(eq(tasks.parentTaskId, input.parentTaskId));
  const nextOrder = (Number(maxOrder?.max) ?? -1) + 1;

  // Create the subtask
  const subtask = await taskService.createTask({
    title: input.title,
    prompt: input.prompt,
    repoUrl: parent.repoUrl,
    agentType: input.agentType ?? parent.agentType,
    priority: input.priority ?? Math.max(1, (parent.priority ?? 100) - 1),
  });

  // Set subtask fields
  await db
    .update(tasks)
    .set({
      parentTaskId: input.parentTaskId,
      taskType: input.taskType ?? "child",
      subtaskOrder: nextOrder,
      blocksParent: input.blocksParent ?? false,
    })
    .where(eq(tasks.id, subtask.id));

  logger.info(
    { parentTaskId: input.parentTaskId, subtaskId: subtask.id, taskType: input.taskType },
    "Subtask created",
  );

  return {
    ...subtask,
    parentTaskId: input.parentTaskId,
    taskType: input.taskType,
    subtaskOrder: nextOrder,
  };
}

/**
 * Queue a subtask for execution.
 */
export async function queueSubtask(subtaskId: string) {
  const subtask = await taskService.getTask(subtaskId);
  if (!subtask) throw new Error("Subtask not found");

  await taskService.transitionTask(subtaskId, TaskState.QUEUED, "subtask_queued");
  await taskQueue.add(
    "process-task",
    { taskId: subtaskId },
    {
      jobId: subtaskId,
      priority: subtask.priority ?? 50,
      attempts: subtask.maxRetries + 1,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
}

/**
 * Get all subtasks for a parent task, ordered by subtaskOrder.
 */
export async function getSubtasks(parentTaskId: string) {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(tasks.subtaskOrder);
}

/**
 * Check if all blocking subtasks of a parent are complete.
 * Returns { allComplete, pending, running, completed, failed }
 */
export async function checkBlockingSubtasks(parentTaskId: string) {
  const subtasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, parentTaskId), eq(tasks.blocksParent, true)));

  if (subtasks.length === 0)
    return { allComplete: true, total: 0, pending: 0, running: 0, completed: 0, failed: 0 };

  const completed = subtasks.filter((s) => s.state === "completed").length;
  const failed = subtasks.filter((s) => s.state === "failed").length;
  const running = subtasks.filter((s) =>
    ["running", "provisioning", "queued"].includes(s.state),
  ).length;
  const pending = subtasks.filter((s) => s.state === "pending").length;

  return {
    allComplete: completed === subtasks.length,
    total: subtasks.length,
    pending,
    running,
    completed,
    failed,
  };
}

/**
 * Called when a subtask completes. Handles:
 * 1. Pipeline step auto-chaining — queue next step when current completes
 * 2. Review subtask handling — auto-merge if approved
 * 3. Parent advancement — when all blocking subtasks are done
 */
export async function onSubtaskComplete(subtaskId: string) {
  const subtask = await taskService.getTask(subtaskId);
  if (!subtask?.parentTaskId) return;

  // ── Pipeline step auto-chaining ─────────────────────────────────
  // When a step completes, auto-queue the next step by subtaskOrder.
  // If the step failed, stop the pipeline (don't queue subsequent steps).
  if (subtask.taskType === "step" && subtask.state === "completed") {
    const siblings = await getSubtasks(subtask.parentTaskId);
    const steps = siblings.filter((s) => s.taskType === "step");
    const currentIdx = steps.findIndex((s) => s.id === subtaskId);
    const nextStep = currentIdx >= 0 ? steps[currentIdx + 1] : undefined;

    if (nextStep && nextStep.state === "pending") {
      try {
        await queueSubtask(nextStep.id);
        logger.info(
          {
            parentTaskId: subtask.parentTaskId,
            completedStep: subtaskId,
            nextStep: nextStep.id,
            stepOrder: `${currentIdx + 2}/${steps.length}`,
          },
          "Pipeline: queued next step",
        );
      } catch (err) {
        logger.warn({ err, nextStepId: nextStep.id }, "Failed to queue next pipeline step");
      }
    }
  }

  const status = await checkBlockingSubtasks(subtask.parentTaskId);
  if (!status.allComplete) return;

  const parent = await taskService.getTask(subtask.parentTaskId);
  if (!parent) return;

  // All blocking subtasks are done — check if parent should auto-advance
  if (parent.state === "pr_opened") {
    // Check if review approved
    const reviewSubtasks = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, parent.id), eq(tasks.taskType, "review")));

    const anyApproved = reviewSubtasks.some((r) => r.state === "completed");

    if (anyApproved && parent.prUrl) {
      logger.info({ taskId: parent.id }, "All blocking subtasks complete, review approved");

      // Auto-merge if enabled on the repo
      const { getRepoByUrl } = await import("./repo-service.js");
      const repoConfig = await getRepoByUrl(parent.repoUrl);

      if (repoConfig?.autoMerge) {
        try {
          const { getGitHubToken } = await import("./github-token-service.js");
          const githubToken = await getGitHubToken({ server: true });

          // Parse PR number from URL
          const prMatch = parent.prUrl.match(/\/pull\/(\d+)/);
          const repoMatch = parent.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
          if (prMatch && repoMatch) {
            const prNumber = prMatch[1];
            const [, owner, repo] = repoMatch;

            const mergeRes = await fetch(
              `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
              {
                method: "PUT",
                headers: {
                  Authorization: `Bearer ${githubToken}`,
                  "User-Agent": "Optio",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  merge_method: "squash",
                }),
              },
            );

            if (mergeRes.ok) {
              await taskService.transitionTask(
                parent.id,
                TaskState.COMPLETED,
                "auto_merged",
                `PR #${prNumber} merged automatically after review approval`,
              );
              logger.info({ taskId: parent.id, prNumber }, "PR auto-merged after review approval");
            } else {
              const body = await mergeRes.json().catch(() => ({}));
              logger.warn(
                { taskId: parent.id, status: mergeRes.status, body },
                "Auto-merge failed",
              );
            }
          }
        } catch (err) {
          logger.warn({ err, taskId: parent.id }, "Failed to auto-merge");
        }
      }
    }
  }

  // If the completed subtask is a step, check if all steps are done to advance parent
  if (subtask.taskType === "step") {
    const allSubtasks = await getSubtasks(parent.id);
    const allSteps = allSubtasks.filter((s) => s.taskType === "step");
    if (allSteps.length > 0) {
      const allStepsComplete = allSteps.every((s) => s.state === "completed");
      if (allStepsComplete) {
        try {
          await taskService.transitionTask(
            parent.id,
            TaskState.COMPLETED,
            "all_steps_complete",
            `All ${allSteps.length} pipeline steps completed`,
          );
          logger.info(
            { parentTaskId: parent.id, stepCount: allSteps.length },
            "Pipeline complete — all steps done",
          );
        } catch (err) {
          logger.warn(
            { err, parentTaskId: parent.id },
            "Failed to complete parent after all steps",
          );
        }
      }
    }
  }

  logger.info({ parentTaskId: parent.id, status }, "All blocking subtasks complete");
}

/**
 * Get pipeline progress for a parent task.
 * Returns null if the task has no step subtasks.
 */
export async function getPipelineProgress(parentTaskId: string) {
  const subtasks = await getSubtasks(parentTaskId);
  const steps = subtasks.filter((s) => s.taskType === "step");
  if (steps.length === 0) return null;

  const completed = steps.filter((s) => s.state === "completed").length;
  const failed = steps.filter((s) => s.state === "failed").length;
  const running = steps.filter((s) =>
    ["running", "provisioning", "queued"].includes(s.state),
  ).length;
  const currentStep = steps.find((s) => !["completed", "failed", "cancelled"].includes(s.state));

  return {
    totalSteps: steps.length,
    completedSteps: completed,
    failedSteps: failed,
    runningSteps: running,
    currentStepIndex: currentStep ? steps.indexOf(currentStep) + 1 : steps.length,
    currentStepTitle: currentStep?.title ?? null,
    steps: steps.map((s) => ({
      id: s.id,
      title: s.title,
      state: s.state,
      subtaskOrder: s.subtaskOrder,
    })),
  };
}
