import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import { taskQueue } from "../workers/task-worker.js";

const resumeSchema = z.object({
  prompt: z.string().min(1).optional(),
});

const forceRestartSchema = z.object({
  prompt: z.string().min(1).optional(),
});

export async function resumeRoutes(app: FastifyInstance) {
  // Resume a task that's in needs_attention or failed state
  app.post("/api/tasks/:id/resume", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = resumeSchema.parse(req.body ?? {});

    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }

    if (!["needs_attention", "failed"].includes(task.state)) {
      return reply.status(409).send({
        error: `Cannot resume task in ${task.state} state`,
      });
    }

    // Transition back to queued
    await taskService.transitionTask(id, TaskState.QUEUED, "user_resume", body.prompt);

    // Enqueue with resume metadata
    await taskQueue.add(
      "process-task",
      {
        taskId: id,
        resumeSessionId: task.sessionId,
        resumePrompt: body.prompt ?? "Continue working on this task.",
      },
      {
        jobId: `${id}-resume-${Date.now()}`,
        attempts: 1,
      },
    );

    const updated = await taskService.getTask(id);
    reply.send({ task: updated });
  });

  // Force-restart: fresh agent session on the existing PR branch.
  // Unlike resume (which tries --resume with the old session ID, fragile if
  // pod was recycled), this checks out the PR branch and starts a new session
  // with a context-aware prompt about what needs fixing.
  app.post("/api/tasks/:id/force-restart", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = forceRestartSchema.parse(req.body ?? {});

    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }

    if (!["needs_attention", "failed", "pr_opened"].includes(task.state)) {
      return reply.status(409).send({
        error: `Cannot force-restart task in ${task.state} state`,
      });
    }

    // Build a context-aware prompt if the user didn't provide one
    const prompt = body.prompt ?? buildRestartPrompt(task);
    const hasPrBranch = !!task.prUrl;

    // Transition back to queued (keeps PR data, logs, etc.)
    await taskService.transitionTask(id, TaskState.QUEUED, "force_restart", prompt.slice(0, 200));

    await taskQueue.add(
      "process-task",
      {
        taskId: id,
        // No resumeSessionId — fresh session, avoids stale session errors
        resumePrompt: prompt,
        restartFromBranch: hasPrBranch,
      },
      {
        jobId: `${id}-restart-${Date.now()}`,
        attempts: 1,
      },
    );

    const updated = await taskService.getTask(id);
    reply.send({ task: updated });
  });
}

function buildRestartPrompt(task: {
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
      "Your PR has merge conflicts with the base branch. Please:\n1. Run `git fetch origin && git rebase origin/main`\n2. Resolve any conflicts\n3. Run the tests to make sure everything still works\n4. Force-push: `git push --force-with-lease`",
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
