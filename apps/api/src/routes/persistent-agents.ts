// Persistent Agent HTTP routes.
//
// Mirrors the workflow routes layout. The polymorphic /api/tasks layer
// gains type='persistent_agent' resolution in tasks-unified.ts.

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as paService from "../services/persistent-agent-service.js";
import {
  PersistentAgentState,
  PersistentAgentPodLifecycle,
  buildSenderId,
  type PersistentAgentControlIntent,
  type PersistentAgentMessageSenderType,
} from "@optio/shared";
import { logAction } from "../services/optio-action-service.js";

const podLifecycleSchema = z.enum(["always-on", "sticky", "on-demand"]);

const createSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens only"),
  name: z.string().min(1),
  description: z.string().optional(),
  agentRuntime: z.string().optional(),
  model: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  agentsMd: z.string().nullable().optional(),
  initialPrompt: z.string().min(1),
  promptTemplateId: z.string().uuid().nullable().optional(),
  repoId: z.string().uuid().nullable().optional(),
  branch: z.string().nullable().optional(),
  podLifecycle: podLifecycleSchema.optional(),
  idlePodTimeoutMs: z.number().int().positive().optional(),
  maxTurnDurationMs: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  consecutiveFailureLimit: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  agentRuntime: z.string().optional(),
  model: z.string().nullable().optional(),
  systemPrompt: z.string().nullable().optional(),
  agentsMd: z.string().nullable().optional(),
  initialPrompt: z.string().min(1).optional(),
  promptTemplateId: z.string().uuid().nullable().optional(),
  repoId: z.string().uuid().nullable().optional(),
  branch: z.string().nullable().optional(),
  podLifecycle: podLifecycleSchema.optional(),
  idlePodTimeoutMs: z.number().int().positive().optional(),
  maxTurnDurationMs: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  consecutiveFailureLimit: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

const sendMessageSchema = z.object({
  body: z.string().min(1),
  senderType: z.enum(["user", "agent", "system", "external"]).optional(),
  senderName: z.string().optional(),
  broadcasted: z.boolean().optional(),
  structuredPayload: z.record(z.unknown()).optional(),
});

const controlSchema = z.object({
  intent: z.enum(["pause", "resume", "archive", "restart"]),
});

const idParamsSchema = z.object({ id: z.string().uuid() });
const turnParamsSchema = z.object({
  id: z.string().uuid(),
  turnId: z.string().uuid(),
});

export async function persistentAgentRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // List
  app.get(
    "/api/persistent-agents",
    {
      schema: {
        operationId: "listPersistentAgents",
        summary: "List persistent agents in the current workspace",
        tags: ["Persistent Agents"],
      },
    },
    async (req, reply) => {
      const agents = await paService.listPersistentAgents(req.user?.workspaceId ?? null);
      reply.send({ agents });
    },
  );

  // Detail
  app.get(
    "/api/persistent-agents/:id",
    {
      schema: {
        operationId: "getPersistentAgent",
        summary: "Get a persistent agent by id",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const agent = await paService.getPersistentAgent(id);
      if (!agent) return reply.code(404).send({ error: "Not found" });
      const inbox = await paService.listInboxSummary(id);
      reply.send({ agent, inbox });
    },
  );

  // Create
  app.post(
    "/api/persistent-agents",
    {
      schema: {
        operationId: "createPersistentAgent",
        summary: "Create a persistent agent",
        tags: ["Persistent Agents"],
        body: createSchema,
      },
    },
    async (req, reply) => {
      const body = req.body;
      const workspaceId = req.user?.workspaceId ?? null;
      try {
        const agent = await paService.createPersistentAgent({
          ...body,
          podLifecycle: body.podLifecycle as PersistentAgentPodLifecycle | undefined,
          workspaceId,
          createdBy: req.user?.id ?? null,
        });
        await logAction({
          action: "persistent_agent.created",
          userId: req.user?.id,
          success: true,
          params: { agentId: agent.id, slug: agent.slug, workspaceId },
        }).catch(() => {});

        // First wake — feed the initial prompt as a system message.
        await paService.wakeAgent({
          agentId: agent.id,
          source: "initial",
          body: body.initialPrompt,
          senderType: "system",
          senderId: buildSenderId({ type: "system", label: "optio-init" }),
          senderName: "Optio",
        });

        reply.code(201).send({ agent });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("unique") || msg.includes("23505")) {
          return reply.code(409).send({ error: `Slug "${body.slug}" already exists` });
        }
        throw err;
      }
    },
  );

  // Update
  app.patch(
    "/api/persistent-agents/:id",
    {
      schema: {
        operationId: "updatePersistentAgent",
        summary: "Update a persistent agent",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
        body: updateSchema,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;
      const updated = await paService.updatePersistentAgent(id, {
        ...body,
        podLifecycle: body.podLifecycle as PersistentAgentPodLifecycle | undefined,
      });
      if (!updated) return reply.code(404).send({ error: "Not found" });
      reply.send({ agent: updated });
    },
  );

  // Delete
  app.delete(
    "/api/persistent-agents/:id",
    {
      schema: {
        operationId: "deletePersistentAgent",
        summary: "Delete a persistent agent",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const ok = await paService.deletePersistentAgent(id);
      if (!ok) return reply.code(404).send({ error: "Not found" });
      reply.code(204).send();
    },
  );

  // Send message — wakes the agent.
  app.post(
    "/api/persistent-agents/:id/messages",
    {
      schema: {
        operationId: "sendPersistentAgentMessage",
        summary: "Send a message to a persistent agent",
        description:
          "Records the message in the agent's inbox and enqueues a reconcile pass " +
          "so the worker picks it up on the next available cycle.",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
        body: sendMessageSchema,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;
      const agent = await paService.getPersistentAgent(id);
      if (!agent) return reply.code(404).send({ error: "Not found" });

      const senderType: PersistentAgentMessageSenderType = body.senderType ?? "user";
      const senderId =
        senderType === "user"
          ? buildSenderId({
              type: "user",
              userId: req.user?.id ?? null,
              label: req.user?.email ?? null,
            })
          : senderType === "agent"
            ? buildSenderId({
                type: "agent",
                workspaceId: agent.workspaceId,
                slug: body.senderName ?? "external",
              })
            : buildSenderId({ type: senderType, label: body.senderName ?? "external" });

      await paService.wakeAgent({
        agentId: id,
        source: senderType === "user" ? "user" : senderType === "agent" ? "agent" : "system",
        body: body.body,
        senderType,
        senderId,
        senderName: body.senderName ?? req.user?.email ?? null,
        broadcasted: body.broadcasted ?? false,
        structuredPayload: body.structuredPayload,
      });

      reply.code(202).send({ ok: true });
    },
  );

  // List recent messages
  app.get(
    "/api/persistent-agents/:id/messages",
    {
      schema: {
        operationId: "listPersistentAgentMessages",
        summary: "List recent messages",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
        querystring: z.object({ limit: z.coerce.number().int().positive().optional() }),
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { limit } = req.query;
      const messages = await paService.listRecentMessages(id, limit ?? 100);
      reply.send({ messages });
    },
  );

  // List turns
  app.get(
    "/api/persistent-agents/:id/turns",
    {
      schema: {
        operationId: "listPersistentAgentTurns",
        summary: "List turns",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
        querystring: z.object({ limit: z.coerce.number().int().positive().optional() }),
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { limit } = req.query;
      const turns = await paService.listPersistentAgentTurns(id, limit ?? 50);
      reply.send({ turns });
    },
  );

  // Turn detail + logs
  app.get(
    "/api/persistent-agents/:id/turns/:turnId",
    {
      schema: {
        operationId: "getPersistentAgentTurn",
        summary: "Get a single turn (with logs)",
        tags: ["Persistent Agents"],
        params: turnParamsSchema,
      },
    },
    async (req, reply) => {
      const { turnId } = req.params;
      const turn = await paService.getPersistentAgentTurn(turnId);
      if (!turn) return reply.code(404).send({ error: "Not found" });
      const logs = await paService.listTurnLogs(turnId);
      reply.send({ turn, logs });
    },
  );

  // Control intent
  // Triggers — list / create
  app.get(
    "/api/persistent-agents/:id/triggers",
    {
      schema: {
        operationId: "listPersistentAgentTriggers",
        summary: "List triggers attached to a persistent agent",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const agent = await paService.getPersistentAgent(id);
      if (!agent) return reply.code(404).send({ error: "Not found" });
      const { db } = await import("../db/client.js");
      const { workflowTriggers } = await import("../db/schema.js");
      const { and, eq } = await import("drizzle-orm");
      const triggers = await db
        .select()
        .from(workflowTriggers)
        .where(
          and(
            eq(workflowTriggers.targetType, "persistent_agent"),
            eq(workflowTriggers.targetId, id),
          ),
        );
      reply.send({ triggers });
    },
  );

  app.post(
    "/api/persistent-agents/:id/triggers",
    {
      schema: {
        operationId: "createPersistentAgentTrigger",
        summary: "Attach a schedule/webhook/manual trigger to a persistent agent",
        description:
          "Creates a row in workflow_triggers with target_type='persistent_agent'. " +
          "The trigger worker dispatches by waking the agent (writing a system message " +
          "into its inbox).",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
        body: z.object({
          type: z.enum(["manual", "schedule", "webhook", "ticket"]),
          config: z.record(z.unknown()),
          paramMapping: z.record(z.unknown()).optional(),
          enabled: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;
      const agent = await paService.getPersistentAgent(id);
      if (!agent) return reply.code(404).send({ error: "Not found" });

      // Validate config shape per trigger type — same rules as workflow triggers.
      if (body.type === "schedule") {
        const cron = body.config.cronExpression;
        if (!cron || typeof cron !== "string") {
          return reply.code(400).send({ error: "Schedule triggers require config.cronExpression" });
        }
      }
      if (body.type === "webhook") {
        const path = body.config.path;
        if (!path || typeof path !== "string") {
          return reply.code(400).send({ error: "Webhook triggers require config.path" });
        }
      }

      const { db } = await import("../db/client.js");
      const { workflowTriggers } = await import("../db/schema.js");
      // For schedule triggers, compute next-fire so the trigger worker picks it up.
      let nextFireAt: Date | null = null;
      if (body.type === "schedule") {
        try {
          const { CronExpressionParser } = await import("cron-parser");
          nextFireAt = CronExpressionParser.parse(body.config.cronExpression as string)
            .next()
            .toDate();
        } catch (err) {
          return reply
            .code(400)
            .send({ error: `Invalid cron expression: ${(err as Error).message}` });
        }
      }
      const [trigger] = await db
        .insert(workflowTriggers)
        .values({
          workflowId: null,
          targetType: "persistent_agent",
          targetId: id,
          type: body.type,
          config: body.config,
          paramMapping: body.paramMapping ?? null,
          enabled: body.enabled ?? true,
          nextFireAt,
        })
        .returning();
      reply.code(201).send({ trigger });
    },
  );

  app.delete(
    "/api/persistent-agents/:id/triggers/:triggerId",
    {
      schema: {
        operationId: "deletePersistentAgentTrigger",
        summary: "Delete a trigger from a persistent agent",
        tags: ["Persistent Agents"],
        params: z.object({ id: z.string().uuid(), triggerId: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      const { triggerId } = req.params;
      const { db } = await import("../db/client.js");
      const { workflowTriggers } = await import("../db/schema.js");
      const { eq } = await import("drizzle-orm");
      const deleted = await db
        .delete(workflowTriggers)
        .where(eq(workflowTriggers.id, triggerId))
        .returning({ id: workflowTriggers.id });
      if (deleted.length === 0) return reply.code(404).send({ error: "Not found" });
      reply.code(204).send();
    },
  );

  app.post(
    "/api/persistent-agents/:id/control",
    {
      schema: {
        operationId: "controlPersistentAgent",
        summary: "Set a control intent (pause/resume/archive/restart)",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
        body: controlSchema,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { intent } = req.body;
      const agent = await paService.getPersistentAgent(id);
      if (!agent) return reply.code(404).send({ error: "Not found" });
      await paService.setControlIntent(id, intent);
      // Wake the reconciler so it observes the intent immediately.
      const { enqueueReconcile } = await import("../services/reconcile-queue.js");
      await enqueueReconcile(
        { kind: "persistent-agent", id },
        { reason: `control_intent_${intent}` },
      );
      reply.send({ ok: true, intent });
    },
  );
}

void PersistentAgentState;
