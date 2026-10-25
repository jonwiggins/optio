import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { teams, users } from "../db/schema.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";
import { auditEvent } from "../services/audit.js";
import { refuseUnlessDeploymentAdmin } from "../services/deployment-admin-gates.js";
import { actorOf } from "../services/ownership.js";
import {
  ChatHookError,
  chooseHookFormat,
  deletePersonalHook,
  deleteTeamChannel,
  getPersonalHook,
  getTeamChannel,
  hookView,
  postChat,
  postToHook,
  setPersonalHook,
  setTeamChannel,
  teamChannelKindViews,
  validateHookUrl,
  type ChatHookRow,
} from "../services/notify/chat-hooks.js";
import { CHAT_HOOK_FORMATS, type ChatHookFormat } from "../services/notify/chat-messages.js";
import { sendDigest } from "../services/notify/digest.js";
import {
  discardDeadLetters,
  listDeadLetters,
  outboxCounts,
  retryDeadLetters,
  retryPolicy,
} from "../services/notify/outbox.js";
import { getChannelChoices } from "../services/notify/preferences.js";
import { requireTeamsEnabled } from "../services/team-service.js";

/**
 * Notifications, finished (docs/notifications.md):
 *
 * - `GET/PUT/DELETE /api/notifications/chat-hook`, `POST …/chat-hook/test` —
 *   the caller's own chat hook, of any chat service (everyone signed in,
 *   viewers too: it is theirs). The URL is never returned.
 * - `GET/PUT/DELETE /api/teams/:id/chat-channel`, `POST …/test` — a team's
 *   channel: its admins, or a workspace admin, as for the team itself; a
 *   team of another workspace is a 404.
 * - `POST /api/notifications/digest/test` — the caller's digest, now.
 * - `GET /api/notifications/outbox`, `POST /api/notifications/outbox/retry`,
 *   `POST /api/notifications/outbox/discard` — what Optio couldn't deliver
 *   (dead letters): deployment admins only, it is the whole deployment's.
 */

const formatSchema = z.enum(CHAT_HOOK_FORMATS as unknown as [ChatHookFormat, ...ChatHookFormat[]]);

const hookBody = z
  .object({
    url: z.string().max(2048).nullable().optional().describe("Omit or leave empty to keep it"),
    format: formatSchema
      .nullable()
      .optional()
      .describe("The chat service; omit when the URL can only be one, or to keep the saved one"),
    enabled: z.boolean().optional(),
  })
  .describe("A chat service's incoming webhook");

const teamChannelBody = hookBody.extend({
  events: z
    .array(z.string().regex(/^[a-z0-9_.-]{1,100}$/))
    .max(50)
    .nullable()
    .optional()
    .describe("The kinds it posts; null = the defaults"),
});

const testHookBody = z
  .object({
    url: z.string().max(2048).optional().describe("Try this URL instead of the saved one"),
    format: formatSchema.optional(),
  })
  .optional()
  .default({});

const idsBody = z
  .object({
    ids: z.array(z.string().uuid()).max(500).optional().describe("Omit for every dead letter"),
  })
  .optional()
  .default({});

const AnyResponse = z.record(z.unknown());

const OUTBOX_REFUSAL = "Only a deployment admin sees and retries what Optio couldn't deliver";

function sendHookError(reply: FastifyReply, err: unknown) {
  if (err instanceof ChatHookError) return reply.status(err.status).send({ error: err.message });
  throw err;
}

async function displayNameOf(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const [me] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId));
  return me?.displayName ?? null;
}

/** The team when it is in the caller's workspace (else 404), and whether they may change its channel. */
async function teamFor(req: FastifyRequest, teamId: string) {
  const actor = actorOf(req);
  const [team] = await db
    .select({ id: teams.id, name: teams.name, workspaceId: teams.workspaceId })
    .from(teams)
    .where(eq(teams.id, teamId));
  if (!team || team.workspaceId !== actor.workspaceId) return null;
  const canManage = actor.isAdmin || (actor.adminTeamIds ?? []).includes(team.id);
  return { team, canManage };
}

const TEAM_REFUSAL = "Only the team's admins (or a workspace admin) set the team's channel";

/**
 * Test a hook: the URL given, in the format a save would choose for it (the
 * one given, else the one the URL can only be, else the saved one; with none
 * of those, a 400), else the saved hook.
 */
async function testHook(
  saved: ChatHookRow | null,
  body: { url?: string; format?: ChatHookFormat },
  where: string,
  sentBy: string | null,
) {
  const message = { type: "test" as const, sentBy, where };
  if (body.url?.trim()) {
    const url = validateHookUrl(body.url);
    return postChat({ url, format: chooseHookFormat(body, url, saved) }, message);
  }
  if (!saved) throw new ChatHookError("Give the hook's URL to test", 400);
  return postToHook(body.format ? { ...saved, format: body.format } : saved, message);
}

export async function notifyDeliveryRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // ── A person's own chat hook ────────────────────────────────────────────

  app.get(
    "/api/notifications/chat-hook",
    {
      schema: {
        operationId: "getMyChatHook",
        summary: "My chat hook",
        description:
          "The caller's own chat incoming webhook (its format, a hint of its " +
          "URL, the last error), or null.",
        tags: ["Workspaces"],
        response: { 200: AnyResponse, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      const row = await getPersonalHook(userId);
      return reply.send({ hook: row ? hookView(row) : null, formats: CHAT_HOOK_FORMATS });
    },
  );

  app.put(
    "/api/notifications/chat-hook",
    {
      schema: {
        operationId: "setMyChatHook",
        summary: "Set my chat hook",
        description:
          "Save the caller's own chat incoming webhook. An empty URL keeps " +
          "the saved one; a format left out is the one the URL can only be, else the saved one. " +
          "Which events reach it is chosen per event (PUT /api/notifications/channels, `chat`).",
        tags: ["Workspaces"],
        body: hookBody,
        response: { 200: AnyResponse, 400: ErrorResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      try {
        const row = await setPersonalHook(userId, req.body);
        void auditEvent({
          req,
          action: "notify.chat_hook.set",
          details: {
            type: row.format,
            enabled: row.enabled,
            fields: req.body.url?.trim() ? ["url", "format"] : ["format"],
          },
        });
        return reply.send({ hook: hookView(row) });
      } catch (err) {
        return sendHookError(reply, err);
      }
    },
  );

  app.delete(
    "/api/notifications/chat-hook",
    {
      schema: {
        operationId: "deleteMyChatHook",
        summary: "Remove my chat hook",
        tags: ["Workspaces"],
        response: { 200: AnyResponse, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      const removed = await deletePersonalHook(userId);
      if (removed) void auditEvent({ req, action: "notify.chat_hook.delete" });
      return reply.send({ hook: null, removed });
    },
  );

  app.post(
    "/api/notifications/chat-hook/test",
    {
      schema: {
        operationId: "testMyChatHook",
        summary: "Send a test message to my chat hook",
        description:
          "Posts a test message now, to `url` (unsaved) or the saved hook. Answers 200 with " +
          "`ok: false`, the HTTP status and what it means when it fails (never the text the chat answered).",
        tags: ["Workspaces"],
        body: testHookBody,
        response: { 200: AnyResponse, 400: ErrorResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      try {
        const result = await testHook(
          await getPersonalHook(userId),
          req.body,
          "your own notifications",
          await displayNameOf(userId),
        );
        return reply.send(result);
      } catch (err) {
        return sendHookError(reply, err);
      }
    },
  );

  // ── A team's channel ────────────────────────────────────────────────────

  app.get(
    "/api/teams/:id/chat-channel",
    {
      preHandler: [requireTeamsEnabled],
      schema: {
        operationId: "getTeamChatChannel",
        summary: "The team's chat channel",
        description:
          "The chat channel the team's work is posted to, and the events it " +
          "can take. The team's admins and workspace admins.",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: { 200: AnyResponse, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const found = await teamFor(req, req.params.id);
      if (!found) return reply.status(404).send({ error: "Team not found" });
      if (!found.canManage) return reply.status(403).send({ error: TEAM_REFUSAL });
      const row = await getTeamChannel(found.team.id);
      return reply.send({
        channel: row ? hookView(row) : null,
        kinds: teamChannelKindViews(),
        formats: CHAT_HOOK_FORMATS,
      });
    },
  );

  app.put(
    "/api/teams/:id/chat-channel",
    {
      preHandler: [requireTeamsEnabled, requireRole("member")],
      schema: {
        operationId: "setTeamChatChannel",
        summary: "Set the team's chat channel",
        description:
          "Save the team's chat incoming webhook and the events it posts. An " +
          "empty URL keeps the saved one. The team's admins and workspace admins.",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        body: teamChannelBody,
        response: {
          200: AnyResponse,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await teamFor(req, req.params.id);
      if (!found) return reply.status(404).send({ error: "Team not found" });
      if (!found.canManage) return reply.status(403).send({ error: TEAM_REFUSAL });
      const userId = req.user?.id ?? (await getChannelOwnerFallback(found.team.id));
      if (!userId) return reply.status(400).send({ error: "Sign in to set the team's channel" });
      try {
        const row = await setTeamChannel(found.team, userId, req.body);
        void auditEvent({
          req,
          action: "team.chat_channel.set",
          details: {
            teamId: found.team.id,
            name: found.team.name,
            type: row.format,
            enabled: row.enabled,
            ...(req.body.events !== undefined ? { events: hookView(row).events } : {}),
            fields: [
              ...(req.body.url?.trim() ? ["url"] : []),
              "format",
              ...(req.body.events !== undefined ? ["events"] : []),
            ],
          },
        });
        return reply.send({ channel: hookView(row), kinds: teamChannelKindViews() });
      } catch (err) {
        return sendHookError(reply, err);
      }
    },
  );

  app.delete(
    "/api/teams/:id/chat-channel",
    {
      preHandler: [requireTeamsEnabled, requireRole("member")],
      schema: {
        operationId: "deleteTeamChatChannel",
        summary: "Remove the team's chat channel",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: { 200: AnyResponse, 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const found = await teamFor(req, req.params.id);
      if (!found) return reply.status(404).send({ error: "Team not found" });
      if (!found.canManage) return reply.status(403).send({ error: TEAM_REFUSAL });
      const removed = await deleteTeamChannel(found.team.id);
      if (removed) {
        void auditEvent({
          req,
          action: "team.chat_channel.delete",
          details: { teamId: found.team.id, name: found.team.name },
        });
      }
      return reply.send({ channel: null, removed });
    },
  );

  app.post(
    "/api/teams/:id/chat-channel/test",
    {
      preHandler: [requireTeamsEnabled, requireRole("member")],
      schema: {
        operationId: "testTeamChatChannel",
        summary: "Send a test message to the team's channel",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        body: testHookBody,
        response: {
          200: AnyResponse,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await teamFor(req, req.params.id);
      if (!found) return reply.status(404).send({ error: "Team not found" });
      if (!found.canManage) return reply.status(403).send({ error: TEAM_REFUSAL });
      try {
        const result = await testHook(
          await getTeamChannel(found.team.id),
          req.body,
          `the team ${found.team.name}`,
          await displayNameOf(req.user?.id),
        );
        return reply.send(result);
      } catch (err) {
        return sendHookError(reply, err);
      }
    },
  );

  // ── The digest ──────────────────────────────────────────────────────────

  app.post(
    "/api/notifications/digest/test",
    {
      schema: {
        operationId: "sendMyDigestNow",
        summary: "Send me my digest now",
        description:
          "Builds the caller's daily digest for the last 24 hours and sends it over the " +
          "channels they picked, even when it is empty or turned off. Answers where it went.",
        tags: ["Workspaces"],
        response: { 200: AnyResponse, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      const { digest } = await getChannelChoices(userId);
      const now = new Date();
      const result = await sendDigest(
        userId,
        digest,
        { since: new Date(now.getTime() - 86_400_000), until: now },
        { sendEmpty: true },
      );
      return reply.send({ ok: result.via.length > 0, ...result });
    },
  );

  // ── Undelivered (deployment admins) ─────────────────────────────────────

  app.get(
    "/api/notifications/outbox",
    {
      schema: {
        operationId: "getNotificationOutbox",
        summary: "What Optio couldn't deliver",
        description:
          "How many emails and chat posts wait to be delivered, the ones Optio gave up on " +
          "(dead letters: recipient, subject, tries, the last error) and the retry policy. " +
          "Deployment admins only.",
        tags: ["Workspaces"],
        response: { 200: AnyResponse, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, OUTBOX_REFUSAL)) return reply;
      const [counts, dead] = await Promise.all([outboxCounts(), listDeadLetters()]);
      const p = retryPolicy();
      return reply.send({
        ...counts,
        items: dead,
        retry: {
          attempts: p.attempts,
          baseSeconds: p.baseMs / 1000,
          deadLetterDays: p.deadLetterDays,
        },
      });
    },
  );

  app.post(
    "/api/notifications/outbox/retry",
    {
      schema: {
        operationId: "retryNotificationOutbox",
        summary: "Try undelivered notifications again",
        description:
          "Gives the dead letters named in `ids` (or all of them) a fresh set of tries. " +
          "Deployment admins only.",
        tags: ["Workspaces"],
        body: idsBody,
        response: { 200: AnyResponse, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, OUTBOX_REFUSAL)) return reply;
      const count = await retryDeadLetters(req.body.ids);
      void auditEvent({
        req,
        action: "notify.outbox.retry",
        workspaceId: null,
        details: { count, ...(req.body.ids ? { ids: req.body.ids.slice(0, 20) } : {}) },
      });
      return reply.send({ retried: count, ...(await outboxCounts()) });
    },
  );

  app.post(
    "/api/notifications/outbox/discard",
    {
      schema: {
        operationId: "discardNotificationOutbox",
        summary: "Discard undelivered notifications",
        description:
          "Forgets the dead letters named in `ids` (or all of them). Deployment admins only.",
        tags: ["Workspaces"],
        body: idsBody,
        response: { 200: AnyResponse, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, OUTBOX_REFUSAL)) return reply;
      const count = await discardDeadLetters(req.body.ids);
      void auditEvent({
        req,
        action: "notify.outbox.discard",
        workspaceId: null,
        details: { count, ...(req.body.ids ? { ids: req.body.ids.slice(0, 20) } : {}) },
      });
      return reply.send({ discarded: count, ...(await outboxCounts()) });
    },
  );
}

/** With auth disabled (local dev) there is no caller: the team's creator keeps the row. */
async function getChannelOwnerFallback(teamId: string): Promise<string | null> {
  const [team] = await db
    .select({ createdBy: teams.createdBy })
    .from(teams)
    .where(eq(teams.id, teamId));
  return team?.createdBy ?? null;
}
