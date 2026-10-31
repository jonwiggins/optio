import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { refuseUnlessDeploymentAdmin } from "../services/deployment-admin-gates.js";
import {
  ChatHookError,
  chooseHookFormat,
  deletePersonalHook,
  getPersonalHook,
  hookView,
  postChat,
  postToHook,
  setPersonalHook,
  validateHookUrl,
  type ChatHookRow,
} from "../services/notify/chat-hooks.js";
import { CHAT_HOOK_FORMATS, type ChatHookFormat } from "../services/notify/chat-messages.js";
import {
  discardDeadLetters,
  listDeadLetters,
  outboxCounts,
  retryDeadLetters,
  retryPolicy,
} from "../services/notify/outbox.js";
import { sendDigest } from "../services/notify/digest.js";
import { getChannelChoices } from "../services/notify/preferences.js";
import { logAction } from "../services/optio-action-service.js";

/**
 * Notification delivery (docs/notifications.md):
 *
 * - `GET/PUT/DELETE /api/notifications/chat-hook`, `POST …/chat-hook/test`:
 *   the caller's own chat hook, of any chat service (everyone signed in,
 *   viewers too: it is theirs). The URL is never returned. Saving and
 *   removing it is recorded in the action log, with whether the URL is
 *   plain http.
 * - `POST /api/notifications/digest/test`: the caller's daily digest, now.
 * - `GET /api/notifications/outbox`, `POST …/outbox/retry`, `POST …/outbox/discard`:
 *   what Optio couldn't deliver (dead letters). Deployment admins only.
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

const testHookBody = z
  .object({
    url: z.string().max(2048).optional().describe("Try this URL instead of the saved one"),
    format: formatSchema.optional(),
  })
  .optional()
  .default({});

const AnyResponse = z.record(z.unknown());
const idsBody = z
  .object({ ids: z.array(z.string().uuid()).max(500).optional() })
  .optional()
  .default({});
const OUTBOX_REFUSAL = "Only a deployment admin can manage undelivered notifications";

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

/** Plain http: the URL (a credential) and every post cross the network unencrypted. */
const isPlaintext = (url: string) => url.startsWith("http://");

/**
 * Test a hook: the URL given, in the format a save would choose for it (the
 * one given, else the one the URL can only be, else the saved one; with none
 * of those, a 400), else the saved hook.
 */
async function testHook(
  saved: ChatHookRow | null,
  body: { url?: string; format?: ChatHookFormat },
  sentBy: string | null,
) {
  const message = { type: "test" as const, sentBy, where: "your own notifications" };
  if (body.url?.trim()) {
    const url = validateHookUrl(body.url);
    return postChat({ url, format: chooseHookFormat(body, url, saved) }, message);
  }
  if (!saved) throw new ChatHookError("Give the hook's URL to test", 400);
  return postToHook(body.format ? { ...saved, format: body.format } : saved, message);
}

export async function notifyDeliveryRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  // ── The caller's own chat hook ──────────────────────────────────────────

  app.get(
    "/api/notifications/chat-hook",
    {
      schema: {
        operationId: "getMyChatHook",
        summary: "My chat hook",
        description:
          "The caller's own chat incoming webhook (its format, a hint of its " +
          "URL, the last error), or null. The URL is never returned.",
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
        const newUrl = req.body.url?.trim() ? validateHookUrl(req.body.url) : null;
        await logAction({
          action: "notify.chat_hook.set",
          userId,
          workspaceId: req.user?.workspaceId ?? null,
          params: { format: row.format, enabled: row.enabled, urlChanged: !!newUrl },
          result: { hook: row.urlHint, plaintextHttp: newUrl ? isPlaintext(newUrl) : undefined },
          success: true,
        }).catch(() => {});
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
      if (removed) {
        await logAction({
          action: "notify.chat_hook.delete",
          userId,
          workspaceId: req.user?.workspaceId ?? null,
          success: true,
        }).catch(() => {});
      }
      return reply.send({ hook: null, removed });
    },
  );

  app.post(
    "/api/notifications/chat-hook/test",
    {
      // Each test is a POST from the API to a host the caller names.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        operationId: "testMyChatHook",
        summary: "Send a test message to my chat hook",
        description:
          "Posts a test message now, to `url` (unsaved) or the saved hook, through the " +
          "outbound guard. Answers 200 with `ok: false`, the HTTP status and what it means " +
          "when it fails (never the text the chat answered). At most 10 a minute.",
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
          await displayNameOf(userId),
        );
        return reply.send(result);
      } catch (err) {
        return sendHookError(reply, err);
      }
    },
  );

  // ── The caller's digest ─────────────────────────────────────────────────

  app.post(
    "/api/notifications/digest/test",
    {
      // Each call builds a digest across the caller's workspaces and sends it.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        operationId: "sendMyDigestNow",
        summary: "Send me my digest now",
        description:
          "Builds the caller's daily digest for the last 24 hours and sends it over the " +
          "channels they picked, even when it is empty or turned off. Answers where it went. " +
          "At most 5 a minute.",
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
          "How many emails wait to be delivered, the ones Optio gave up on " +
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
      await logAction({
        action: "notify.outbox.retry",
        userId: req.user?.id,
        workspaceId: req.user?.workspaceId ?? null,
        result: { count },
        success: true,
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
      await logAction({
        action: "notify.outbox.discard",
        userId: req.user?.id,
        workspaceId: req.user?.workspaceId ?? null,
        result: { count },
        success: true,
      });
      return reply.send({ discarded: count, ...(await outboxCounts()) });
    },
  );
}
