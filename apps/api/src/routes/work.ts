/**
 * `/api/work` — every kind of agent work as one resource, the way the UI
 * shows it: the list, any id, creation from the five attributes, editing and
 * deleting a saved definition, what a definition has started, and the
 * triggers that start it. See services/work-service.ts (reading),
 * services/work-write-service.ts (writing), and docs/tasks.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { inView, type TriggerTargetType } from "@optio/shared";
import * as workService from "../services/work-service.js";
import * as workWrite from "../services/work-write-service.js";
import * as triggerService from "../services/trigger-service.js";
import { TRIGGER_TARGET } from "../services/work-definition-service.js";
import { getPersistentAgentScoped } from "../services/persistent-agent-service.js";
import { workActor, workChangeError } from "../services/work-ownership.js";
import { logAction } from "../services/optio-action-service.js";
import { environmentOptions } from "../services/agent-environment-service.js";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import {
  CreateTriggerBodySchema,
  UpdateTriggerBodySchema,
  replyTriggerError,
} from "../schemas/trigger.js";
import {
  WorkCreatedSchema,
  WorkDetailResponseSchema,
  WorkEnvironmentQuerySchema,
  WorkEnvironmentResponseSchema,
  WorkListQuerySchema,
  WorkListResponseSchema,
  WorkRunsResponseSchema,
  WorkSpecSchema,
  WorkTriggerResponseSchema,
  WorkTriggersResponseSchema,
} from "../schemas/work.js";

const TriggerParamsSchema = z.object({ id: z.string(), triggerId: z.string() });
const WorkErrorSchema = ErrorResponseSchema;

export async function workRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const member = { preHandler: [requireRole("member")] };

  app.get(
    "/api/work",
    {
      schema: {
        operationId: "listWork",
        summary: "List work",
        description:
          "Every piece of work the caller can see — Tasks, scheduled Tasks, Jobs, Local " +
          "automations and sessions, pod sessions, and persistent agents — projected onto " +
          "When / Where / Who / Then and one status scale, needs-you first. Workspace rows are " +
          "scoped to the current workspace; machines and pod sessions to the caller.",
        tags: ["Work"],
        querystring: WorkListQuerySchema,
        response: { 200: WorkListResponseSchema },
      },
    },
    async (req, reply) => {
      const rows = await workService.listWork(scopeOf(req));
      const view = req.query.view ?? "all";
      reply.send({ rows: rows.filter((r) => inView(r, view)) });
    },
  );

  app.post(
    "/api/work",
    {
      ...member,
      schema: {
        operationId: "createWork",
        summary: "Create work from its attributes",
        description:
          "Creates whatever the answers describe — the kind is derived, never sent: a Task, " +
          "a scheduled Task, a Job (started now when nothing else starts it), a Local " +
          "automation or terminal, a pod session, or a persistent agent. A saved definition " +
          "and its trigger are written together, so a rejected trigger leaves nothing behind. " +
          "A 409 says which uniqueness it ran into in `details` (`name_taken`, " +
          "`webhook_path_taken`). Requires `member` role.",
        tags: ["Work"],
        body: WorkSpecSchema,
        response: {
          201: WorkCreatedSchema,
          400: WorkErrorSchema,
          403: WorkErrorSchema,
          409: WorkErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const created = await withWorkErrors(reply, () =>
        workWrite.createWork(req.body, actorOf(req)),
      );
      if (!created) return;
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "work.create",
        params: { kind: created.kind, name: req.body.name },
        result: { id: created.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send(created);
    },
  );

  app.get(
    "/api/work/environment",
    {
      schema: {
        operationId: "getWorkEnvironment",
        summary: "What a piece of pod work's agent could get",
        description:
          "The connections, MCP servers, and skills an agent in a pod could get for work on " +
          "this repo (or none) with this runtime, each marked when the repo and the workspace " +
          "give it by default, plus the repo's own setup commands and PR settings. The Where " +
          "section of the New work form starts from these and saves only the changes " +
          "(`WorkSpec.settings`).",
        tags: ["Work"],
        querystring: WorkEnvironmentQuerySchema,
        response: { 200: WorkEnvironmentResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = workActor(req);
      reply.send(
        await environmentOptions({
          repoUrl: req.query.repoUrl || null,
          agentType: req.query.agentType || "claude-code",
          workspaceId: actor.workspaceId,
          ownerUserId: req.query.owner === "me" ? actor.userId : null,
        }),
      );
    },
  );

  app.get(
    "/api/work/:id",
    {
      schema: {
        operationId: "getWork",
        summary: "Get a piece of work by id",
        description:
          "Resolves the id across every kind of work and returns its stored row plus the " +
          "row the Work list shows for it.",
        tags: ["Work"],
        params: IdParamsSchema,
        response: { 200: WorkDetailResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const resolved = await workService.resolveWork(req.params.id, scopeOf(req));
      if (!resolved) return reply.status(404).send({ error: "Work not found" });
      reply.send({ source: resolved.source, row: resolved.row, work: resolved.data });
    },
  );

  app.patch(
    "/api/work/:id",
    {
      ...member,
      schema: {
        operationId: "updateWork",
        summary: "Save a definition from its attributes",
        description:
          "Saves a scheduled Task, Job, or Local automation from the same attributes it was " +
          "created from. Its kind is fixed: the answers are read for the saved kind, and ones " +
          "it can't take (a scheduled Task with no repo) are a 400. " +
          "The trigger the form edits (the first enabled one) follows the When answer, in the " +
          "same transaction. Requires `member` role.",
        tags: ["Work"],
        params: IdParamsSchema,
        body: WorkSpecSchema,
        response: {
          200: WorkCreatedSchema,
          400: WorkErrorSchema,
          403: WorkErrorSchema,
          404: WorkErrorSchema,
          409: WorkErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const saved = await withWorkErrors(reply, () =>
        workWrite.updateWork(req.params.id, req.body, actorOf(req)),
      );
      if (saved) reply.send(saved);
    },
  );

  app.delete(
    "/api/work/:id",
    {
      ...member,
      schema: {
        operationId: "deleteWork",
        summary: "Delete a definition",
        description:
          "Deletes a scheduled Task, Job, or Local automation and its triggers. A Job's runs " +
          "go with it; tasks and terminals a definition started stay. Requires `member` role.",
        tags: ["Work"],
        params: IdParamsSchema,
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const deleted = await withWorkErrors(reply, () =>
        workWrite.deleteWork(req.params.id, actorOf(req)),
      );
      if (deleted === null) return;
      if (!deleted) return reply.status(404).send({ error: "Work not found" });
      reply.status(204).send(null);
    },
  );

  app.get(
    "/api/work/:id/runs",
    {
      schema: {
        operationId: "listWorkRuns",
        summary: "What a definition has started",
        description:
          "A scheduled Task's tasks, a Job's runs, or a Local automation's terminals, newest " +
          "first, as Work list rows.",
        tags: ["Work"],
        params: IdParamsSchema,
        response: { 200: WorkRunsResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const definition = await workWrite.getOwnDefinition(req.params.id, actorOf(req));
      if (!definition) return reply.status(404).send({ error: "Work not found" });
      reply.send({ runs: await workService.listRuns(definition, scopeOf(req)) });
    },
  );

  // ── Triggers: the When of a definition or a persistent agent ──────────────

  /**
   * Where an id's triggers are filed, if it is work that takes them and the
   * caller can see it, and whose it is (personal work's triggers are its
   * owner's to change).
   */
  async function triggerTarget(
    id: string,
    req: FastifyRequest,
  ): Promise<{
    targetType: TriggerTargetType;
    targetId: string;
    /** The 403 for changing its triggers, if the caller may not. */
    changeError(): Promise<string | null>;
  } | null> {
    const actor = workActor(req);
    const definition = await workWrite.getOwnDefinition(id, actor);
    if (definition) {
      return {
        targetType: TRIGGER_TARGET[definition.kind],
        targetId: id,
        changeError: () =>
          workWrite.assertMayChange(definition, actor, "edit").then(
            () => null,
            (err: unknown) =>
              err instanceof workWrite.WorkError ? err.message : Promise.reject(err),
          ),
      };
    }
    const agent = await getPersistentAgentScoped(id, req.user?.workspaceId ?? null);
    if (!agent) return null;
    return {
      targetType: "persistent_agent",
      targetId: id,
      changeError: () => workChangeError(agent.ownerUserId, actor, "edit"),
    };
  }

  app.get(
    "/api/work/:id/triggers",
    {
      schema: {
        operationId: "listWorkTriggers",
        summary: "List what starts a piece of work",
        tags: ["Work"],
        params: IdParamsSchema,
        response: { 200: WorkTriggersResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const target = await triggerTarget(req.params.id, req);
      if (!target) return reply.status(404).send({ error: "Work not found" });
      reply.send({
        triggers: await triggerService.listTriggers(target.targetType, target.targetId),
      });
    },
  );

  app.post(
    "/api/work/:id/triggers",
    {
      ...member,
      schema: {
        operationId: "createWorkTrigger",
        summary: "Attach a trigger",
        tags: ["Work"],
        params: IdParamsSchema,
        body: CreateTriggerBodySchema,
        response: {
          201: WorkTriggerResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const target = await triggerTarget(req.params.id, req);
      if (!target) return reply.status(404).send({ error: "Work not found" });
      const forbidden = await target.changeError();
      if (forbidden) return reply.status(403).send({ error: forbidden });
      const input = req.body;
      const problem = triggerService.validateTriggerConfig(input.type, input.config);
      if (problem) return reply.status(400).send({ error: problem });
      try {
        const trigger = await triggerService.createTrigger({ ...target, ...input });
        reply.status(201).send({ trigger });
      } catch (err) {
        if (replyTriggerError(reply, err, input)) return;
        throw err;
      }
    },
  );

  app.patch(
    "/api/work/:id/triggers/:triggerId",
    {
      ...member,
      schema: {
        operationId: "updateWorkTrigger",
        summary: "Update a trigger",
        tags: ["Work"],
        params: TriggerParamsSchema,
        body: UpdateTriggerBodySchema,
        response: {
          200: WorkTriggerResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const target = await triggerTarget(req.params.id, req);
      const existing =
        target &&
        (await triggerService.getTriggerFor(
          target.targetType,
          target.targetId,
          req.params.triggerId,
        ));
      if (!existing) return reply.status(404).send({ error: "Trigger not found" });
      const forbidden = await target!.changeError();
      if (forbidden) return reply.status(403).send({ error: forbidden });
      if (req.body.config) {
        const problem = triggerService.validateTriggerConfig(existing.type, req.body.config);
        if (problem) return reply.status(400).send({ error: problem });
      }
      try {
        const trigger = await triggerService.updateTrigger(existing.id, req.body);
        if (!trigger) return reply.status(404).send({ error: "Trigger not found" });
        reply.send({ trigger });
      } catch (err) {
        if (replyTriggerError(reply, err, req.body)) return;
        throw err;
      }
    },
  );

  app.delete(
    "/api/work/:id/triggers/:triggerId",
    {
      ...member,
      schema: {
        operationId: "deleteWorkTrigger",
        summary: "Delete a trigger",
        tags: ["Work"],
        params: TriggerParamsSchema,
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const target = await triggerTarget(req.params.id, req);
      const existing =
        target &&
        (await triggerService.getTriggerFor(
          target.targetType,
          target.targetId,
          req.params.triggerId,
        ));
      if (!existing) return reply.status(404).send({ error: "Trigger not found" });
      const forbidden = await target!.changeError();
      if (forbidden) return reply.status(403).send({ error: forbidden });
      await triggerService.deleteTrigger(existing.id);
      reply.status(204).send(null);
    },
  );
}

/** Run a write; a `WorkError` becomes its reply (and the result null). */
async function withWorkErrors<T>(reply: FastifyReply, write: () => Promise<T>): Promise<T | null> {
  try {
    return await write();
  } catch (err) {
    if (!(err instanceof workWrite.WorkError)) throw err;
    reply
      .status(err.status)
      .send({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    return null;
  }
}

function scopeOf(req: { user?: { id: string; workspaceId?: string | null } }) {
  return { workspaceId: req.user?.workspaceId ?? null, userId: req.user?.id ?? null };
}

const actorOf = workActor;
