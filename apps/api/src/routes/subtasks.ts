import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as subtaskService from "../services/subtask-service.js";
import * as taskService from "../services/task-service.js";

const createSubtaskSchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  taskType: z.enum(["review", "step", "child"]).optional(),
  blocksParent: z.boolean().optional(),
  agentType: z.string().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  autoQueue: z.boolean().optional(),
});

export async function subtaskRoutes(app: FastifyInstance) {
  // List subtasks for a task
  app.get("/api/tasks/:id/subtasks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const subtasks = await subtaskService.getSubtasks(id);
    reply.send({ subtasks });
  });

  // Create a subtask
  app.post("/api/tasks/:id/subtasks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const body = createSubtaskSchema.parse(req.body);

    const subtask = await subtaskService.createSubtask({
      parentTaskId: id,
      title: body.title,
      prompt: body.prompt,
      taskType: body.taskType,
      blocksParent: body.blocksParent,
      agentType: body.agentType,
      priority: body.priority,
    });

    // For pipeline steps: only auto-queue the first step (lowest subtaskOrder).
    // Subsequent steps stay pending and are auto-queued by onSubtaskComplete().
    const shouldAutoQueue = (() => {
      if (body.autoQueue === false) return false;
      if (body.taskType === "step") {
        // Check if there are already running/queued step siblings
        // If so, this is not the first step — don't auto-queue
        return subtask.subtaskOrder === 0;
      }
      return true;
    })();

    if (shouldAutoQueue) {
      await subtaskService.queueSubtask(subtask.id);
    }

    reply.status(201).send({ subtask });
  });

  // Check blocking subtask status
  app.get("/api/tasks/:id/subtasks/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const status = await subtaskService.checkBlockingSubtasks(id);
    reply.send(status);
  });
}
