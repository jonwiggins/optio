import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";
import { actorOf } from "../services/ownership.js";
import { logAction } from "../services/optio-action-service.js";
import { auditEvent } from "../services/audit.js";
import {
  TeamError,
  addMember,
  createTeam,
  decideRequest,
  deleteTeam,
  getTeam,
  leaveTeam,
  listTeams,
  removeMember,
  requestToJoin,
  requireTeamsEnabled,
  setGroupMappings,
  setMemberRole,
  updateTeam,
} from "../services/team-service.js";

/**
 * Teams (docs/teams.md): `/api/teams`. Any member creates one; its admins
 * (or a workspace admin) run it; anyone in the workspace asks to join. Off
 * until a deployment admin turns teams on (Settings → Access → Teams): until
 * then every route here answers 404.
 */

const roleSchema = z.enum(["admin", "member"]);
const joinPolicySchema = z.enum(["open", "request", "closed"]);

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  joinPolicy: joinPolicySchema.optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  joinPolicy: joinPolicySchema.optional(),
});

const memberParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof TeamError) return reply.status(err.status).send({ error: err.message });
  throw err;
}

export async function teamRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", requireTeamsEnabled);

  app.get(
    "/api/teams",
    {
      schema: {
        operationId: "listTeams",
        summary: "The workspace's teams, with the caller's standing in each",
        tags: ["Workspaces"],
        response: { 200: z.object({ teams: z.array(z.unknown()) }) },
      },
    },
    async (req, reply) => {
      reply.send({ teams: await listTeams(actorOf(req)) });
    },
  );

  app.post(
    "/api/teams",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createTeam",
        summary: "Create a team (the caller becomes its first admin)",
        tags: ["Workspaces"],
        body: createSchema,
        response: { 201: z.unknown(), 400: ErrorResponseSchema, 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const team = await createTeam(req.body, actorOf(req));
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "team.create",
          params: { name: req.body.name },
          result: { id: team.id },
          success: true,
          clientIp: req.ip, // The audit trail (docs/audit.md).
        }).catch(() => {});
        reply.status(201).send({ team });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/api/teams/:id",
    {
      schema: {
        operationId: "getTeam",
        summary: "A team with its members (requests and group mappings for its admins)",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: { 200: z.unknown(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        reply.send({ team: await getTeam(req.params.id, actorOf(req)) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.patch(
    "/api/teams/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateTeam",
        summary: "Rename a team, change its description or join policy",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        body: updateSchema,
        response: {
          200: z.unknown(),
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const team = await updateTeam(req.params.id, req.body, actorOf(req));
        void auditEvent({
          req,
          action: "team.update",
          details: { teamId: req.params.id, fields: Object.keys(req.body).sort() },
        });
        reply.send({ team });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/api/teams/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deleteTeam",
        summary: "Delete a team (what it owns goes with it)",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        await deleteTeam(req.params.id, actorOf(req));
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "team.delete",
          params: { id: req.params.id, teamId: req.params.id },
          result: {},
          success: true,
          clientIp: req.ip, // The audit trail (docs/audit.md).
        }).catch(() => {});
        reply.status(204).send(null);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── Joining ───────────────────────────────────────────────────────────────

  app.post(
    "/api/teams/:id/join",
    {
      schema: {
        operationId: "joinTeam",
        summary: "Ask to join a team (an open team admits at once)",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: {
          200: z.unknown(),
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const team = await requestToJoin(req.params.id, actorOf(req));
        // Joined at once (an open team) or asked (docs/audit.md).
        const mine = team.members?.find((m) => m.userId === req.user?.id);
        void auditEvent({
          req,
          action: mine?.status === "active" ? "team.join" : "team.join.request",
          details: { teamId: req.params.id },
        });
        reply.send({ team });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/api/teams/:id/join",
    {
      schema: {
        operationId: "leaveTeam",
        summary: "Leave a team, or withdraw a request to join it",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: { 204: z.null(), 400: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        await leaveTeam(req.params.id, actorOf(req));
        void auditEvent({ req, action: "team.leave", details: { teamId: req.params.id } });
        reply.status(204).send(null);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/api/teams/:id/members/:userId/decide",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "decideTeamRequest",
        summary: "Approve or deny someone's request to join",
        tags: ["Workspaces"],
        params: memberParams,
        body: z.object({ decision: z.enum(["approve", "deny"]) }),
        response: { 200: z.unknown(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const team = await decideRequest(
          req.params.id,
          req.params.userId,
          req.body.decision,
          actorOf(req),
        );
        void auditEvent({
          req,
          action: `team.join.${req.body.decision}`,
          details: { teamId: req.params.id, targetUserId: req.params.userId },
        });
        reply.send({ team });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ── Members ───────────────────────────────────────────────────────────────

  app.post(
    "/api/teams/:id/members",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "addTeamMember",
        summary: "Add someone to a team by email or user id",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        body: z
          .object({
            userId: z.string().uuid().optional(),
            email: z.string().email().optional(),
            role: roleSchema.optional(),
          })
          .refine((b) => b.userId || b.email, { message: "userId or email is required" }),
        response: { 200: z.unknown(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const team = await addMember(
          req.params.id,
          { userId: req.body.userId, email: req.body.email },
          req.body.role ?? "member",
          actorOf(req),
        );
        void auditEvent({
          req,
          action: "team.member.add",
          details: {
            teamId: req.params.id,
            targetUserId: req.body.userId,
            email: req.body.userId ? undefined : req.body.email,
            role: req.body.role ?? "member",
          },
        });
        reply.send({ team });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.patch(
    "/api/teams/:id/members/:userId",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "setTeamMemberRole",
        summary: "Make a member a team admin, or an admin a member",
        tags: ["Workspaces"],
        params: memberParams,
        body: z.object({ role: roleSchema }),
        response: {
          200: z.unknown(),
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const team = await setMemberRole(
          req.params.id,
          req.params.userId,
          req.body.role,
          actorOf(req),
        );
        void auditEvent({
          req,
          action: "team.member.role",
          details: { teamId: req.params.id, targetUserId: req.params.userId, role: req.body.role },
        });
        reply.send({ team });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/api/teams/:id/members/:userId",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "removeTeamMember",
        summary: "Remove someone from a team",
        tags: ["Workspaces"],
        params: memberParams,
        response: {
          200: z.unknown(),
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const team = await removeMember(req.params.id, req.params.userId, actorOf(req));
        void auditEvent({
          req,
          action: "team.member.remove",
          details: { teamId: req.params.id, targetUserId: req.params.userId },
        });
        reply.send({ team });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put(
    "/api/teams/:id/groups",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "setTeamGroupMappings",
        summary: "Which identity-provider groups fill this team, and with which role",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        body: z.object({
          mappings: z
            .array(z.object({ groupName: z.string().trim().min(1).max(200), role: roleSchema }))
            .max(50),
        }),
        response: { 200: z.unknown(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const team = await setGroupMappings(req.params.id, req.body.mappings, actorOf(req));
        void auditEvent({
          req,
          action: "team.groups",
          details: { teamId: req.params.id, count: req.body.mappings.length },
        });
        reply.send({ team });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
