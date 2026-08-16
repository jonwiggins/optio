import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { TaskSchema } from "../schemas/task.js";
import { requireRole } from "../plugins/auth.js";

const resumeSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe("Optional follow-up instructions. Defaults to 'Continue working on this task.'"),
  })
  .describe("Body for resuming a needs_attention / failed task");

const forceRestartSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional instructions for the restart. If omitted, Optio auto-generates " +
          "a context-aware prompt based on the task's PR status and error message.",
      ),
  })
  .describe("Body for force-restarting a task with a fresh agent session");

const TaskResponseSchema = z
  .object({
    task: TaskSchema.nullable(),
  })
  .describe("Updated task after resume / restart");

export async function resumeRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/tasks/:id/resume",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "resumeTask",
        summary: "Resume a task in needs_attention or failed state",
        description:
          "Transition a task back to `queued` and enqueue it with `--resume` " +
          "metadata so the agent picks up where it left off (reuses the " +
          "stored session ID). Fails with 409 if the task isn't in one of " +
          "the resumable states. For stale-session recovery prefer " +
          "`/force-restart`.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        body: resumeSchema,
        response: {
          200: TaskResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;

      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && task.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }

      if (!["needs_attention", "failed"].includes(task.state)) {
        return reply.status(409).send({
          error: `Cannot resume task in ${task.state} state`,
        });
      }

      await taskService.transitionTask(id, TaskState.QUEUED, "user_resume", body.prompt);

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
    },
  );

  app.post(
    "/api/tasks/:id/force-restart",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "forceRestartTask",
        summary: "Start a fresh agent session on the existing PR branch",
        description:
          "Unlike `/resume` (which tries `--resume` with the old session " +
          "ID and is fragile if the pod was recycled), this checks out the " +
          "existing PR branch and launches a brand-new session with a " +
          "context-aware prompt about what needs fixing. Accepts " +
          "`needs_attention`, `failed`, or `pr_opened`.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        body: forceRestartSchema,
        response: {
          200: TaskResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;

      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && task.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }

      if (!["needs_attention", "failed", "pr_opened"].includes(task.state)) {
        return reply.status(409).send({
          error: `Cannot force-restart task in ${task.state} state`,
        });
      }

      const prompt = body.prompt ?? buildRestartPrompt(task);
      const hasPrBranch = !!task.prUrl;

      await taskService.transitionTask(id, TaskState.QUEUED, "force_restart", prompt.slice(0, 200));

      await taskQueue.add(
        "process-task",
        {
          taskId: id,
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
    },
  );
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
