import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as subtaskService from "../services/subtask-service.js";
import * as taskService from "../services/task-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { TaskSchema, SubtaskStatusSchema } from "../schemas/task.js";
import { requireRole } from "../plugins/auth.js";

const createSubtaskSchema = z
  .object({
    title: z.string().min(1).describe("Human-readable subtask title"),
    prompt: z.string().min(1).describe("Agent prompt for this subtask"),
    taskType: z
      .enum(["review", "step", "child"])
      .optional()
      .describe("Relationship to parent: review (blocks), step (pipeline), or child (sibling)"),
    blocksParent: z
      .boolean()
      .optional()
      .describe("If true the parent cannot complete until this subtask does"),
    agentType: z.string().optional().describe("Agent runtime override"),
    priority: z.number().int().min(1).max(1000).optional().describe("Priority override"),
    autoQueue: z
      .boolean()
      .optional()
      .describe("If false, create but do not queue. Defaults to true except for non-first steps."),
  })
  .describe("Body for creating a subtask under a parent task");

const SubtasksListResponseSchema = z
  .object({
    subtasks: z.array(TaskSchema),
  })
  .describe("List of subtasks for a parent task");

const SubtaskCreatedResponseSchema = z
  .object({
    subtask: TaskSchema,
  })
  .describe("Newly-created subtask");

export async function subtaskRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/tasks/:id/subtasks",
    {
      schema: {
        operationId: "listSubtasks",
        summary: "List subtasks for a task",
        description:
          "Return all subtasks (review, step, or child) nested under a parent task in " +
          "the current workspace.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: SubtasksListResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && task.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const subtasks = await subtaskService.getSubtasks(id);
      reply.send({ subtasks });
    },
  );

  app.post(
    "/api/tasks/:id/subtasks",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createSubtask",
        summary: "Create a subtask",
        description:
          "Create a new subtask under the parent task. For pipeline `step` " +
          "subtasks, only the first (lowest `subtaskOrder`) is auto-queued; " +
          "subsequent steps stay pending and are queued automatically by " +
          "`onSubtaskComplete`. Pass `autoQueue: false` to skip queuing " +
          "entirely.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        body: createSubtaskSchema,
        response: {
          201: SubtaskCreatedResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && task.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const body = req.body;

      const subtask = await subtaskService.createSubtask({
        parentTaskId: id,
        title: body.title,
        prompt: body.prompt,
        taskType: body.taskType,
        blocksParent: body.blocksParent,
        agentType: body.agentType,
        priority: body.priority,
      });

      const shouldAutoQueue = (() => {
        if (body.autoQueue === false) return false;
        if (body.taskType === "step") {
          return subtask.subtaskOrder === 0;
        }
        return true;
      })();

      if (shouldAutoQueue) {
        await subtaskService.queueSubtask(subtask.id);
      }

      reply.status(201).send({ subtask });
    },
  );

  app.get(
    "/api/tasks/:id/subtasks/status",
    {
      schema: {
        operationId: "getBlockingSubtaskStatus",
        summary: "Check blocking subtask status",
        description:
          "Return whether any subtasks are still blocking the parent task from completing, " +
          "and the IDs of the blockers.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: SubtaskStatusSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && task.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const status = await subtaskService.checkBlockingSubtasks(id);
      reply.send(status);
    },
  );
}
