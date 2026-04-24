import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import * as messageService from "../services/task-message-service.js";
import { publishTaskMessage } from "../services/task-message-bus.js";
import { publishEvent } from "../services/event-bus.js";
import { getRedisClient } from "../services/event-bus.js";
import { taskQueue } from "../workers/task-worker.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { TaskMessageSchema } from "../schemas/task.js";

// States from which a stopped task can be resumed by sending a chat message.
// Matches the states accepted by POST /api/tasks/:id/resume and force-restart.
const RESUMABLE_STATES: readonly string[] = [
  TaskState.NEEDS_ATTENTION,
  TaskState.PR_OPENED,
  TaskState.FAILED,
  TaskState.CANCELLED,
];

const sendMessageSchema = z
  .object({
    content: z.string().min(1).max(8000).describe("Message body to deliver to the agent"),
    mode: z
      .enum(["soft", "interrupt"])
      .default("soft")
      .describe(
        "`soft` queues the message for the next turn; `interrupt` attempts " +
          "to preempt the running turn (claude-code only for now)",
      ),
  })
  .describe("Body for sending a message to a running task");

const MessageAcceptedResponseSchema = z
  .object({
    message: TaskMessageSchema,
  })
  .describe("Message accepted and queued for delivery");

const MessagesListResponseSchema = z
  .object({
    messages: z.array(TaskMessageSchema),
  })
  .describe("All messages sent to a task");

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export async function messageRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/tasks/:id/message",
    {
      schema: {
        operationId: "sendTaskMessage",
        summary: "Send a message to a running or stopped task",
        description:
          "Deliver a user message to a task. Behavior depends on state:\n\n" +
          "- **running**: mid-turn delivery via the Redis channel → task-worker " +
          "→ stream-json stdin. Claude Code only; other agents return 501.\n" +
          "- **needs_attention / pr_opened / failed / cancelled**: resumes the " +
          "agent with the message as the new prompt (re-enqueues the task, " +
          "reusing the stored session id when available). Works for any agent " +
          "type.\n" +
          "- **pending / queued / provisioning / completed**: 409 — no running " +
          "agent can consume the message and the task isn't in a resumable " +
          "state.\n\n" +
          "Rate limited to 10 messages per user per task per minute.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        body: sendMessageSchema,
        response: {
          202: MessageAcceptedResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          429: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { content, mode } = req.body;

      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });

      const wsId = req.user?.workspaceId;
      if (wsId && task.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Task not found" });
      }

      if (req.user?.id) {
        const allowed = await messageService.canMessageTask(req.user.id, task);
        if (!allowed) {
          return reply.status(403).send({ error: "Not authorized to message this task" });
        }
      }

      const isRunning = task.state === TaskState.RUNNING;
      const isResumable = RESUMABLE_STATES.includes(task.state);
      if (!isRunning && !isResumable) {
        // pending / waiting_on_deps / queued / provisioning — task hasn't
        // started yet and has no running agent. completed — terminal, can't
        // be resumed. In both cases the agent can't consume a message now.
        return reply.status(409).send({
          error:
            `Task is in '${task.state}' state. ` +
            `Messages can be sent to running tasks or used to resume stopped tasks ` +
            `(needs_attention / pr_opened / failed / cancelled). ` +
            `This task is not in a state where a message can be delivered.`,
        });
      }

      // Mid-turn messaging (running) requires the claude-code stream-json
      // stdin bridge. Resume-from-chat re-enqueues the task and doesn't care
      // about the agent type — any agent can receive the message as a resume
      // prompt.
      if (isRunning && task.agentType !== "claude-code") {
        return reply.status(501).send({
          error:
            "Mid-task messaging is currently only supported for Claude Code. Other agents will be supported via tmux wrapping in a follow-up.",
        });
      }

      if (req.user?.id) {
        const redis = getRedisClient();
        const rateLimitKey = `optio:msg-rate:${id}:${req.user.id}`;
        const count = await redis.incr(rateLimitKey);
        if (count === 1) {
          await redis.expire(rateLimitKey, RATE_LIMIT_WINDOW_SECONDS);
        }
        if (count > RATE_LIMIT_MAX) {
          return reply.status(429).send({
            error: `Rate limit exceeded. Maximum ${RATE_LIMIT_MAX} messages per minute per task.`,
          });
        }
      }

      const message = await messageService.sendMessage({
        taskId: id,
        content,
        mode,
        userId: req.user?.id,
        workspaceId: task.workspaceId ?? undefined,
      });

      // Record the message arrival itself (non-transitioning event) so the
      // task timeline shows user input even for the running-delivery path.
      // The interrupt subtype is preserved when applicable.
      const messageTrigger = mode === "interrupt" ? "user_interrupt" : "user_message";
      await taskService.recordTaskEvent(
        id,
        task.state,
        messageTrigger,
        content.slice(0, 200),
        req.user?.id,
      );

      const userDisplayName = req.user?.displayName ?? null;
      await publishEvent({
        type: "task:message",
        taskId: id,
        messageId: message.id,
        userId: req.user?.id ?? null,
        userDisplayName,
        content,
        mode,
        createdAt: message.createdAt.toISOString(),
      });

      if (isRunning) {
        // Deliver mid-turn via the Redis channel → task-worker → stream-json stdin.
        await publishTaskMessage(id, {
          messageId: message.id,
          content,
          mode,
          userDisplayName,
        });
      } else {
        // Stopped + resumable: transition to queued and enqueue a resume run
        // with the user's message as the new prompt. The agent picks up from
        // the stored session id (if any) so context is preserved.
        await taskService.transitionTask(
          id,
          TaskState.QUEUED,
          "user_message_resume",
          content.slice(0, 200),
        );
        await taskQueue.add(
          "process-task",
          {
            taskId: id,
            resumeSessionId: task.sessionId ?? undefined,
            resumePrompt: content,
          },
          {
            jobId: `${id}-chat-${Date.now()}`,
            attempts: 1,
          },
        );
        // We'll mark delivery once the worker picks up and writes the first
        // log; for the chat UX, acking when the resume is queued is accurate
        // enough — the user's message has been handed off to the agent.
        await messageService.markDelivered(message.id).catch(() => {});
        await publishEvent({
          type: "task:message_delivered",
          taskId: id,
          messageId: message.id,
          timestamp: new Date().toISOString(),
        });
      }

      app.log.info(
        {
          taskId: id,
          messageId: message.id,
          userId: req.user?.id,
          fromState: task.state,
          delivery: isRunning ? "running-stdin" : "resume-queue",
          contentPreview: content.slice(0, 200),
        },
        "Task message sent",
      );

      reply.status(202).send({
        message: {
          id: message.id,
          taskId: message.taskId,
          userId: message.userId,
          content: message.content,
          mode: message.mode,
          createdAt: message.createdAt.toISOString(),
          deliveredAt: isRunning ? null : new Date().toISOString(),
          ackedAt: null,
        },
      });
    },
  );

  app.get(
    "/api/tasks/:id/messages",
    {
      schema: {
        operationId: "listTaskMessages",
        summary: "List messages sent to a task",
        description:
          "Return all messages ever sent to a task, including their delivery " +
          "state. The returned list is ordered chronologically.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: MessagesListResponseSchema,
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

      const messages = await messageService.listMessages(id);
      reply.send({
        messages: messages.map((m) => ({
          id: m.id,
          taskId: m.taskId,
          userId: m.userId,
          content: m.content,
          mode: m.mode,
          createdAt: m.createdAt,
          deliveredAt: m.deliveredAt,
          ackedAt: m.ackedAt,
          deliveryError: m.deliveryError,
          user: m.user,
        })),
      });
    },
  );
}
