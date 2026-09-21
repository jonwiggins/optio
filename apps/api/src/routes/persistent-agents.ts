// Persistent Agent HTTP routes.
//
// Mirrors the workflow routes layout. The polymorphic /api/tasks layer
// gains type='persistent_agent' resolution in tasks-unified.ts.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
import * as triggerService from "../services/trigger-service.js";
import { CreateTriggerBodySchema, replyTriggerError } from "../schemas/trigger.js";
import { requireRole } from "../plugins/auth.js";

/**
 * Resolve an agent that belongs to the caller's workspace, or send a 404 and
 * return null. Every `/:id` handler funnels through this so a caller can never
 * read, mutate, or wake another tenant's persistent agent by primary key.
 *
 * We deliberately return 404 (not 403) for foreign agents so the endpoint does
 * not become a cross-tenant existence oracle. Mirrors the workspace guard in
 * `routes/tasks.ts`. When auth is disabled (local dev) `req.user` is undefined,
 * so `workspaceId` is null and the scoped lookup matches the null-workspace
 * rows that local dev creates — behavior is preserved.
 */
async function requireAgent(req: FastifyRequest, reply: FastifyReply, id: string) {
  const agent = await paService.getPersistentAgentScoped(id, req.user?.workspaceId ?? null);
  if (!agent) {
    reply.code(404).send({ error: "Not found" });
    return null;
  }
  return agent;
}

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
  agentOptions: z
    .record(z.union([z.string(), z.boolean()]))
    .nullable()
    .optional(),
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
  agentOptions: z
    .record(z.union([z.string(), z.boolean()]))
    .nullable()
    .optional(),
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

  // Aggregated stats — must precede `/:id` so the literal segment wins
  app.get(
    "/api/persistent-agents/stats",
    {
      schema: {
        operationId: "getPersistentAgentStats",
        summary: "Get aggregated persistent agent stats",
        description:
          "Returns counts of `persistent_agents` grouped by state for the " +
          "current workspace. Mirrors `/api/tasks/stats` so dashboards can " +
          "render an agents stats bar symmetrically with tasks. Archived " +
          "agents are excluded from `total` because they are terminal.",
        tags: ["Persistent Agents"],
      },
    },
    async (req, reply) => {
      const stats = await paService.getPersistentAgentStats(req.user?.workspaceId ?? null);
      reply.send({ stats });
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
      const agent = await requireAgent(req, reply, id);
      if (!agent) return;
      const inbox = await paService.listInboxSummary(id);
      reply.send({ agent, inbox });
    },
  );

  // Create
  app.post(
    "/api/persistent-agents",
    {
      preHandler: [requireRole("member")],
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
      preHandler: [requireRole("member")],
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
      const workspaceId = req.user?.workspaceId ?? null;
      const existing = await requireAgent(req, reply, id);
      if (!existing) return;
      const updated = await paService.updatePersistentAgent(
        id,
        {
          ...body,
          podLifecycle: body.podLifecycle as PersistentAgentPodLifecycle | undefined,
        },
        workspaceId,
      );
      if (!updated) return reply.code(404).send({ error: "Not found" });
      reply.send({ agent: updated });
    },
  );

  // Delete
  app.delete(
    "/api/persistent-agents/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deletePersistentAgent",
        summary: "Delete a persistent agent",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const workspaceId = req.user?.workspaceId ?? null;
      const existing = await requireAgent(req, reply, id);
      if (!existing) return;
      const ok = await paService.deletePersistentAgent(id, workspaceId);
      if (!ok) return reply.code(404).send({ error: "Not found" });
      reply.code(204).send();
    },
  );

  // Send message — wakes the agent.
  app.post(
    "/api/persistent-agents/:id/messages",
    {
      preHandler: [requireRole("member")],
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
      const agent = await requireAgent(req, reply, id);
      if (!agent) return;

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
      const agent = await requireAgent(req, reply, id);
      if (!agent) return;
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
      const agent = await requireAgent(req, reply, id);
      if (!agent) return;
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
      const { id, turnId } = req.params;
      const agent = await requireAgent(req, reply, id);
      if (!agent) return;
      const turn = await paService.getPersistentAgentTurn(turnId);
      // Also verify the turn belongs to this agent so a valid-for-caller id
      // cannot be paired with another agent's turnId.
      if (!turn || turn.agentId !== id) return reply.code(404).send({ error: "Not found" });
      const logs = await paService.listTurnLogs(turnId);
      reply.send({ turn, logs });
    },
  );

  // Control intent
  // Triggers — list / create / delete. The same trigger service every other
  // target uses: any of the seven types, incl. GitHub / Slack / Linear events
  // (the dispatcher wakes the agent with the event as a system message).
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
      const agent = await requireAgent(req, reply, id);
      if (!agent) return;
      const triggers = await triggerService.listTriggers("persistent_agent", id);
      reply.send({ triggers });
    },
  );

  app.post(
    "/api/persistent-agents/:id/triggers",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createPersistentAgentTrigger",
        summary: "Attach a trigger to a persistent agent",
        description:
          "Creates a row in workflow_triggers with target_type='persistent_agent': a schedule, " +
          "a webhook, a ticket filter, or a GitHub / Slack / Linear event. A firing wakes the " +
          "agent by writing a system message into its inbox.",
        tags: ["Persistent Agents"],
        params: idParamsSchema,
        body: CreateTriggerBodySchema,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;
      const agent = await requireAgent(req, reply, id);
      if (!agent) return;

      const configError = triggerService.validateTriggerConfig(body.type, body.config);
      if (configError) return reply.code(400).send({ error: configError });
      try {
        const trigger = await triggerService.createTrigger({
          targetType: "persistent_agent",
          targetId: id,
          type: body.type,
          config: body.config,
          paramMapping: body.paramMapping,
          enabled: body.enabled,
        });
        reply.code(201).send({ trigger });
      } catch (err) {
        if (replyTriggerError(reply, err, body)) return;
        reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete(
    "/api/persistent-agents/:id/triggers/:triggerId",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deletePersistentAgentTrigger",
        summary: "Delete a trigger from a persistent agent",
        tags: ["Persistent Agents"],
        params: z.object({ id: z.string().uuid(), triggerId: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      const { id, triggerId } = req.params;
      const agent = await requireAgent(req, reply, id);
      if (!agent) return;
      // Scoped to this agent's triggers so a trigger id from another agent
      // (or another tenant) can't be removed via a valid-for-caller :id.
      const existing = await triggerService.getTriggerFor("persistent_agent", id, triggerId);
      if (!existing) return reply.code(404).send({ error: "Not found" });
      await triggerService.deleteTrigger(triggerId);
      reply.code(204).send();
    },
  );

  app.post(
    "/api/persistent-agents/:id/control",
    {
      preHandler: [requireRole("member")],
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
      const workspaceId = req.user?.workspaceId ?? null;
      const agent = await requireAgent(req, reply, id);
      if (!agent) return;
      await paService.setControlIntent(id, intent, workspaceId);
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
