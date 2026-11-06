import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  refuseUnlessDeploymentAdmin,
  requesterIsDeploymentAdmin,
} from "../services/deployment-admin-gates.js";
import {
  PAUSE_REASON_MAX,
  START_ROUTES,
  agentWorkPauseHold,
  getAgentWorkPause,
  pauseAgentWork,
  pauserName,
  resumeAgentWork,
  stopAllAgentWork,
} from "../services/agent-work-pause.js";
import { logAction } from "../services/optio-action-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";

/**
 * Pausing all agent work (services/agent-work-pause.ts,
 * docs/pausing-agent-work.md). Anyone signed in reads the state (the banner);
 * only a deployment admin pauses, resumes or stops everything, and each is
 * written to the action log with who and why.
 */

const ADMIN_ONLY = "Only a deployment admin pauses or stops agent work";

const ReasonSchema = z
  .string()
  .trim()
  .min(1, "Say why (the reason is shown to everyone)")
  .max(PAUSE_REASON_MAX)
  .describe("Why, shown to everyone in the banner and kept in the action log");

const PauseStateSchema = z.object({
  paused: z.boolean().describe("No new agent work starts while true"),
  reason: z.string().nullable(),
  pausedAt: z.string().nullable().describe("ISO time the pause began"),
  pausedBy: z
    .object({ id: z.string(), name: z.string().nullable() })
    .nullable()
    .describe("The deployment admin who paused"),
  stopped: z.boolean().describe("The pause came with Stop everything"),
  canEdit: z.boolean().describe("The caller is a deployment admin"),
});

const PauseBodySchema = z
  .object({
    paused: z.boolean(),
    reason: ReasonSchema.optional().describe("Required to pause"),
  })
  .describe("Pause (with a reason) or resume all agent work");

const StopBodySchema = z.object({ reason: ReasonSchema }).describe("Stop all agent work");

const StopCountsSchema = z.object({
  tasks: z.number().int(),
  jobRuns: z.number().int(),
  reviews: z.number().int(),
  agents: z.number().int(),
  sessions: z.number().int(),
  terminals: z.number().int(),
  skipped: z.number().int().describe("Runs whose cancel did not land (finished meanwhile)"),
});

function signedIn(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.user || isAuthDisabled()) return true;
  void reply.status(401).send({ error: "Authentication required" });
  return false;
}

async function state(req: FastifyRequest) {
  const pause = await getAgentWorkPause();
  return {
    paused: !!pause,
    reason: pause?.reason ?? null,
    pausedAt: pause?.pausedAt ?? null,
    pausedBy: pause?.pausedBy
      ? { id: pause.pausedBy, name: await pauserName(pause.pausedBy) }
      : null,
    stopped: pause?.stopped ?? false,
    canEdit: await requesterIsDeploymentAdmin(req),
  };
}

/**
 * Refuse the interactive starts (`START_ROUTES`) with 409 and the reason while
 * paused. Added on the root instance before the routes, so it covers them all.
 */
export function refuseStartsWhilePaused(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    const route = req.routeOptions?.url;
    if (!route || !START_ROUTES.has(`${req.method} ${route}`)) return;
    const hold = await agentWorkPauseHold();
    if (hold) return reply.status(409).send({ error: hold });
  });
}

export async function agentWorkRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/agent-work/pause",
    {
      schema: {
        operationId: "getAgentWorkPause",
        summary: "Whether agent work is paused",
        description:
          "Whether a deployment admin has paused all agent work, why, since when and by " +
          "whom, and whether the caller may change it. Anyone signed in may read it.",
        tags: ["Setup & Settings"],
        response: { 200: PauseStateSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (!signedIn(req, reply)) return reply;
      reply.send(await state(req));
    },
  );

  app.put(
    "/api/agent-work/pause",
    {
      schema: {
        operationId: "setAgentWorkPause",
        summary: "Pause or resume all agent work",
        description:
          "Deployment admins only. Paused: no new agent work starts in any workspace; queued " +
          "and triggered work is held and starts when the pause lifts, interactive starts are " +
          "refused (409). Work already running carries on. A reason is required to pause.",
        tags: ["Setup & Settings"],
        body: PauseBodySchema,
        response: {
          200: PauseStateSchema,
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!signedIn(req, reply)) return reply;
      if (await refuseUnlessDeploymentAdmin(req, reply, ADMIN_ONLY)) return reply;
      const userId = req.user?.id ?? null;
      if (req.body.paused) {
        if (!req.body.reason) return reply.status(400).send({ error: "A reason is required" });
        await pauseAgentWork(req.body.reason, userId);
        await logAction({
          workspaceId: null,
          userId: userId ?? undefined,
          action: "agent_work.pause",
          params: {},
          result: { reason: req.body.reason },
          success: true,
        }).catch(() => {});
      } else {
        const was = await resumeAgentWork(userId);
        if (was)
          await logAction({
            workspaceId: null,
            userId: userId ?? undefined,
            action: "agent_work.resume",
            params: {},
            result: { reason: req.body.reason ?? null },
            success: true,
          }).catch(() => {});
      }
      reply.send(await state(req));
    },
  );

  app.post(
    "/api/agent-work/stop",
    {
      schema: {
        operationId: "stopAllAgentWork",
        summary: "Stop all agent work",
        description:
          "Deployment admins only. Pauses agent work and cancels every queued or running " +
          "Task, Job run, PR review, persistent agent turn, interactive session and Optio Local " +
          "agent terminal in every workspace, through each one's own cancel path. Resume with " +
          "PUT /api/agent-work/pause.",
        tags: ["Setup & Settings"],
        body: StopBodySchema,
        response: {
          200: PauseStateSchema.extend({ cancelled: StopCountsSchema }),
          400: ErrorResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (!signedIn(req, reply)) return reply;
      if (await refuseUnlessDeploymentAdmin(req, reply, ADMIN_ONLY)) return reply;
      const userId = req.user?.id ?? null;
      const { cancelled } = await stopAllAgentWork(req.body.reason, userId);
      await logAction({
        workspaceId: null,
        userId: userId ?? undefined,
        action: "agent_work.stop",
        params: {},
        result: { reason: req.body.reason, cancelled },
        success: true,
      }).catch(() => {});
      reply.send({ ...(await state(req)), cancelled });
    },
  );
}
