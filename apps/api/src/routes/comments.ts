import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as commentService from "../services/comment-service.js";
import * as taskService from "../services/task-service.js";

const createCommentSchema = z.object({
  content: z.string().min(1).max(10000),
});

const updateCommentSchema = z.object({
  content: z.string().min(1).max(10000),
});

export async function commentRoutes(app: FastifyInstance) {
  // List comments for a task — verify workspace
  app.get("/api/tasks/:id/comments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const comments = await commentService.listComments(id);
    reply.send({ comments });
  });

  // Add a comment to a task — verify workspace
  app.post("/api/tasks/:id/comments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const { content } = createCommentSchema.parse(req.body);
    const comment = await commentService.addComment(id, content, req.user?.id);
    reply.status(201).send({ comment });
  });

  // Update a comment
  app.patch("/api/tasks/:taskId/comments/:commentId", async (req, reply) => {
    const { taskId, commentId } = req.params as { taskId: string; commentId: string };
    const task = await taskService.getTask(taskId);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const { content } = updateCommentSchema.parse(req.body);
    try {
      const comment = await commentService.updateComment(commentId, content, req.user?.id);
      reply.send({ comment });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Comment not found") return reply.status(404).send({ error: message });
      if (message.includes("Not authorized")) return reply.status(403).send({ error: message });
      throw err;
    }
  });

  // Delete a comment
  app.delete("/api/tasks/:taskId/comments/:commentId", async (req, reply) => {
    const { taskId, commentId } = req.params as { taskId: string; commentId: string };
    const task = await taskService.getTask(taskId);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    try {
      await commentService.deleteComment(commentId, req.user?.id);
      reply.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "Comment not found") return reply.status(404).send({ error: message });
      if (message.includes("Not authorized")) return reply.status(403).send({ error: message });
      throw err;
    }
  });

  // Activity feed: interleaved comments + events — verify workspace
  app.get("/api/tasks/:id/activity", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = await taskService.getTask(id);
    if (!task) return reply.status(404).send({ error: "Task not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && task.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Task not found" });
    }
    const [comments, events] = await Promise.all([
      commentService.listComments(id),
      taskService.getTaskEvents(id),
    ]);

    const activity = [
      ...comments.map((c) => ({
        type: "comment" as const,
        id: c.id,
        taskId: c.taskId,
        content: c.content,
        user: c.user,
        createdAt: c.createdAt,
      })),
      ...events.map((e) => ({
        type: "event" as const,
        id: e.id,
        taskId: e.taskId,
        fromState: e.fromState,
        toState: e.toState,
        trigger: e.trigger,
        message: e.message,
        userId: e.userId,
        createdAt: e.createdAt,
      })),
    ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    reply.send({ activity });
  });
}
