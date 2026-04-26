// Internal HTTP endpoints used by Persistent Agents to call back into Optio
// from inside their pods. Documented in the agent's `agents.md` operator
// manual so the agent learns the API on its own.
//
// Auth: the agent's own UUID is treated as an unguessable bearer token,
// passed in via `OPTIO_AGENT_TOKEN`. Combined with workspace scoping this
// is acceptable for v0.4 — a follow-up should harden by generating per-turn
// signed tokens and validating the source pod.

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, isNull, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { persistentAgents } from "../db/schema.js";
import * as paService from "../services/persistent-agent-service.js";
import { buildSenderId } from "@optio/shared";
import { logger } from "../logger.js";

const sendBodySchema = z.object({
  to: z.string().min(1).describe("Target agent slug (e.g. 'forge') in this workspace"),
  body: z.string().min(1),
  broadcast: z.boolean().optional(),
  payload: z.record(z.unknown()).optional(),
});

const broadcastBodySchema = z.object({
  body: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
});

async function authAgentByToken(token: string | undefined) {
  if (!token) return null;
  const [agent] = await db.select().from(persistentAgents).where(eq(persistentAgents.id, token));
  return agent ?? null;
}

export async function persistentAgentInternalRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  /**
   * List addressable agents in the caller's workspace. Returned shape is
   * intentionally compact to keep agent prompts cheap.
   */
  app.get(
    "/api/internal/persistent-agents",
    {
      schema: {
        operationId: "internalListAddressableAgents",
        summary: "List addressable persistent agents in caller's workspace",
        tags: ["Persistent Agents (internal)"],
      },
    },
    async (req, reply) => {
      const token = req.headers["x-optio-agent-token"] as string | undefined;
      const me = await authAgentByToken(token);
      if (!me) return reply.code(401).send({ error: "invalid OPTIO_AGENT_TOKEN" });

      const peers = await db
        .select({
          slug: persistentAgents.slug,
          name: persistentAgents.name,
          description: persistentAgents.description,
          state: persistentAgents.state,
          enabled: persistentAgents.enabled,
        })
        .from(persistentAgents)
        .where(
          me.workspaceId
            ? eq(persistentAgents.workspaceId, me.workspaceId)
            : isNull(persistentAgents.workspaceId),
        );
      reply.send({ agents: peers, me: { slug: me.slug } });
    },
  );

  /**
   * Send a direct message to one agent (by slug, in caller's workspace).
   * Returns 202 immediately — the recipient picks it up on its next
   * scheduled turn.
   */
  app.post(
    "/api/internal/persistent-agents/send",
    {
      schema: {
        operationId: "internalSendMessageToAgent",
        summary: "Send a direct message to another persistent agent",
        tags: ["Persistent Agents (internal)"],
        body: sendBodySchema,
      },
    },
    async (req, reply) => {
      const token = req.headers["x-optio-agent-token"] as string | undefined;
      const me = await authAgentByToken(token);
      if (!me) return reply.code(401).send({ error: "invalid OPTIO_AGENT_TOKEN" });

      const body = req.body;
      const target = await paService.getPersistentAgentBySlug(me.workspaceId ?? null, body.to);
      if (!target) return reply.code(404).send({ error: `unknown agent slug "${body.to}"` });
      if (target.id === me.id) {
        return reply.code(400).send({ error: "cannot message self" });
      }

      await paService.wakeAgent({
        agentId: target.id,
        source: "agent",
        body: body.body,
        senderType: "agent",
        senderId: buildSenderId({
          type: "agent",
          workspaceId: me.workspaceId,
          slug: me.slug,
        }),
        senderName: me.name,
        broadcasted: body.broadcast ?? false,
        structuredPayload: body.payload,
      });

      logger.info(
        { from: me.slug, to: target.slug, broadcast: body.broadcast ?? false },
        "Agent → agent message",
      );
      reply.code(202).send({ ok: true, to: target.slug });
    },
  );

  /**
   * Broadcast a message to all other agents in the caller's workspace.
   * Skips the sender. Each recipient receives a separate message marked
   * broadcasted=true.
   */
  app.post(
    "/api/internal/persistent-agents/broadcast",
    {
      schema: {
        operationId: "internalBroadcastToAgents",
        summary: "Broadcast to all peer agents in workspace",
        tags: ["Persistent Agents (internal)"],
        body: broadcastBodySchema,
      },
    },
    async (req, reply) => {
      const token = req.headers["x-optio-agent-token"] as string | undefined;
      const me = await authAgentByToken(token);
      if (!me) return reply.code(401).send({ error: "invalid OPTIO_AGENT_TOKEN" });

      const body = req.body;
      const peers = await db
        .select()
        .from(persistentAgents)
        .where(
          me.workspaceId
            ? and(
                eq(persistentAgents.workspaceId, me.workspaceId),
                eq(persistentAgents.enabled, true),
              )
            : and(isNull(persistentAgents.workspaceId), eq(persistentAgents.enabled, true)),
        );

      let delivered = 0;
      const senderId = buildSenderId({
        type: "agent",
        workspaceId: me.workspaceId,
        slug: me.slug,
      });
      for (const peer of peers) {
        if (peer.id === me.id) continue;
        await paService.wakeAgent({
          agentId: peer.id,
          source: "agent",
          body: body.body,
          senderType: "agent",
          senderId,
          senderName: me.name,
          broadcasted: true,
          structuredPayload: body.payload,
        });
        delivered++;
      }
      logger.info({ from: me.slug, delivered }, "Agent broadcast");
      reply.code(202).send({ ok: true, delivered });
    },
  );

  /**
   * Read recent messages on the caller's own inbox (already-drained ones too)
   * — useful when the agent wants to recall earlier context within a turn.
   */
  app.get(
    "/api/internal/persistent-agents/inbox",
    {
      schema: {
        operationId: "internalReadOwnInbox",
        summary: "Read caller's recent messages",
        tags: ["Persistent Agents (internal)"],
        querystring: z.object({ limit: z.coerce.number().int().positive().max(200).optional() }),
      },
    },
    async (req, reply) => {
      const token = req.headers["x-optio-agent-token"] as string | undefined;
      const me = await authAgentByToken(token);
      if (!me) return reply.code(401).send({ error: "invalid OPTIO_AGENT_TOKEN" });
      const { limit } = req.query;
      const messages = await paService.listRecentMessages(me.id, limit ?? 50);
      reply.send({ messages });
    },
  );
}
