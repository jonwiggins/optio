import { actorOf, canSee } from "../services/ownership.js";
import { canSeeWork } from "../services/work-visibility.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as commentService from "../services/comment-service.js";
import * as taskService from "../services/task-service.js";
import * as messageService from "../services/task-message-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { TaskCommentSchema, ActivityItemSchema } from "../schemas/task.js";

const commentParamsSchema = z
  .object({
    taskId: z.string().describe("Task UUID"),
    commentId: z.string().describe("Comment UUID"),
  })
  .describe("Path parameters for comment update/delete");

const createCommentSchema = z
  .object({
    content: z.string().min(1).max(10000).describe("Comment body (markdown)"),
  })
  .describe("Body for adding a comment");

const updateCommentSchema = z
  .object({
    content: z.string().min(1).max(10000).describe("New comment body (markdown)"),
  })
  .describe("Body for updating a comment");

const CommentListResponseSchema = z
  .object({
    comments: z.array(TaskCommentSchema),
  })
  .describe("All comments on a task, chronological");

const CommentResponseSchema = z
  .object({
    comment: TaskCommentSchema,
  })
  .describe("A single comment envelope");

const ActivityResponseSchema = z
  .object({
    activity: z.array(ActivityItemSchema),
  })
  .describe("Interleaved comments, state-change events, and messages for a task");

export async function commentRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/tasks/:id/comments",
    {
      schema: {
        operationId: "listTaskComments",
        summary: "List comments on a task",
        description: "Return all comments on a task in chronological order.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: CommentListResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if ((wsId && task.workspaceId !== wsId) || !canSeeWork(task, actorOf(req))) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const comments = await commentService.listComments(id);
      reply.send({ comments });
    },
  );

  app.post(
    "/api/tasks/:id/comments",
    {
      schema: {
        operationId: "addTaskComment",
        summary: "Add a comment to a task",
        description: "Create a new comment on a task. Authenticated users only.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        body: createCommentSchema,
        response: {
          201: CommentResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if ((wsId && task.workspaceId !== wsId) || !canSeeWork(task, actorOf(req))) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const { content } = req.body;
      const comment = await commentService.addComment(id, content, req.user?.id);
      reply.status(201).send({ comment });
    },
  );

  app.patch(
    "/api/tasks/:taskId/comments/:commentId",
    {
      schema: {
        operationId: "updateTaskComment",
        summary: "Update a comment",
        description:
          "Edit an existing comment. Only the original author or a workspace " +
          "admin can update a comment (enforced in the service layer).",
        tags: ["Tasks"],
        params: commentParamsSchema,
        body: updateCommentSchema,
        response: {
          200: CommentResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { taskId, commentId } = req.params;
      const task = await taskService.getTask(taskId);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if ((wsId && task.workspaceId !== wsId) || !canSeeWork(task, actorOf(req))) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const { content } = req.body;
      try {
        const comment = await commentService.updateComment(
          taskId,
          commentId,
          content,
          req.user?.id,
        );
        reply.send({ comment });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "Comment not found") return reply.status(404).send({ error: message });
        if (message.includes("Not authorized")) return reply.status(403).send({ error: message });
        throw err;
      }
    },
  );

  app.delete(
    "/api/tasks/:taskId/comments/:commentId",
    {
      schema: {
        operationId: "deleteTaskComment",
        summary: "Delete a comment",
        description:
          "Delete an existing comment. Only the original author or a workspace " +
          "admin can delete a comment. Returns 204 on success.",
        tags: ["Tasks"],
        params: commentParamsSchema,
        response: {
          204: z.null().describe("Comment deleted"),
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { taskId, commentId } = req.params;
      const task = await taskService.getTask(taskId);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if ((wsId && task.workspaceId !== wsId) || !canSeeWork(task, actorOf(req))) {
        return reply.status(404).send({ error: "Task not found" });
      }
      try {
        await commentService.deleteComment(taskId, commentId, req.user?.id);
        reply.status(204).send(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "Comment not found") return reply.status(404).send({ error: message });
        if (message.includes("Not authorized")) return reply.status(403).send({ error: message });
        throw err;
      }
    },
  );

  app.get(
    "/api/tasks/:id/activity",
    {
      schema: {
        operationId: "getTaskActivityFeed",
        summary: "Get the activity feed for a task",
        description:
          "Return a chronological, interleaved feed of comments, " +
          "state-transition events, and user messages for a task. Useful " +
          "for rendering a single unified audit view.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: ActivityResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if ((wsId && task.workspaceId !== wsId) || !canSeeWork(task, actorOf(req))) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const [comments, events, messages] = await Promise.all([
        commentService.listComments(id),
        taskService.getTaskEvents(id),
        messageService.listMessages(id),
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
        ...messages.map((m) => ({
          type: "message" as const,
          id: m.id,
          taskId: m.taskId,
          content: m.content,
          mode: m.mode,
          user: m.user,
          senderType: m.senderType,
          senderName: m.senderName,
          senderAddress: m.senderAddress,
          deliveredAt: m.deliveredAt,
          ackedAt: m.ackedAt,
          createdAt: m.createdAt,
        })),
      ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      reply.send({ activity });
    },
  );
}
