import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { isDeploymentAdmin } from "../services/sign-in-config-service.js";
import { logAction } from "../services/optio-action-service.js";
import { DEFAULT_PREFERENCES, isVapidConfigured } from "../services/notification-service.js";
import { isPushConfigured } from "../services/push-fanout.js";
import { NOTIFY_KINDS } from "../services/notify/kinds.js";
import { getChannelChoices, updateChannelChoices } from "../services/notify/preferences.js";
import { emailAvailable, sendEmail } from "../services/notify/email.js";
import { isEmailAddress } from "../services/notify/mime.js";
import {
  SmtpConfigError,
  configFromInput,
  deleteSmtpSettings,
  saveSmtpSettings,
  smtpSettingsView,
} from "../services/notify/smtp-config.js";
import { renderTestEmail } from "../services/notify/templates.js";

/**
 * Notifications inside the network (docs/notifications.md):
 *
 * - `GET/PUT /api/notifications/channels` — the caller's own choices: per
 *   event, email, their own chat hook and push on or off, whether they hear
 *   about the work of the teams they administer, and their daily digest.
 *   Everyone signed in, viewers too (their own). The hook itself, team
 *   channels and undelivered mail: routes/notify-delivery.ts.
 * - `GET/PUT/DELETE /api/notifications/smtp`, `POST /api/notifications/smtp/test`
 *   — the relay Optio sends email through. Deployment admins only: it is the
 *   whole deployment's, like sign-in.
 */

const kindKey = z.string().regex(/^[a-z0-9_.-]{1,100}$/, "an event kind like task.failed");

const channelsBody = z
  .object({
    email: z.record(kindKey, z.boolean()).optional(),
    push: z
      .record(kindKey, z.boolean())
      .refine((p) => Object.keys(p).every((k) => k in DEFAULT_PREFERENCES), {
        message: "push is only for the events that have it",
      })
      .optional(),
    teamWork: z.boolean().optional(),
  })
  .describe("Change some of the caller's notification choices; the rest stay");

const smtpBody = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    security: z.enum(["starttls", "starttls-required", "tls", "none"]),
    username: z.string().max(320).nullable().optional(),
    password: z.string().max(1024).nullable().optional(),
    from: z.string().min(3).max(320),
    caPem: z.string().max(65536).nullable().optional(),
    insecureSkipVerify: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .describe("The SMTP relay; a blank password keeps the saved one, null clears it");

const testBody = z
  .object({
    to: z.string().max(320).optional().describe("Default: the caller's own address"),
    settings: smtpBody.optional().describe("Try these instead of the saved settings"),
  })
  .optional()
  .default({});

const AnyResponse = z.record(z.unknown());

async function deploymentAdminOnly(req: FastifyRequest, reply: FastifyReply) {
  if (isAuthDisabled()) return;
  if (req.user && (await isDeploymentAdmin(req.user))) return;
  return reply
    .status(403)
    .send({ error: "Only a deployment admin can change how Optio sends email" });
}

async function channelsView(userId: string) {
  const [choices, emailOn, me] = await Promise.all([
    getChannelChoices(userId),
    emailAvailable(),
    db.select({ email: users.email }).from(users).where(eq(users.id, userId)),
  ]);
  const address = me[0]?.email ?? null;
  return {
    kinds: NOTIFY_KINDS.map((k) => ({
      kind: k.kind,
      label: k.label,
      description: k.description,
      about: k.about,
      push: k.push,
    })),
    choices,
    email: { available: emailOn, address: isEmailAddress(address) ? address : null },
    push: { available: isVapidConfigured() || isPushConfigured() },
  };
}

function sendConfigError(reply: FastifyReply, err: unknown) {
  if (err instanceof SmtpConfigError) return reply.status(err.status).send({ error: err.message });
  throw err;
}

export async function notifyRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const admin = { preHandler: [deploymentAdminOnly] };

  app.get(
    "/api/notifications/channels",
    {
      schema: {
        operationId: "getNotificationChannels",
        summary: "My notification choices",
        description:
          "The events Optio tells people about, the caller's choice of email and push for " +
          "each, whether email and push are available on this deployment, and the address " +
          "email goes to.",
        tags: ["Workspaces"],
        response: { 200: AnyResponse, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      return reply.send(await channelsView(userId));
    },
  );

  app.put(
    "/api/notifications/channels",
    {
      schema: {
        operationId: "updateNotificationChannels",
        summary: "Change my notification choices",
        description:
          "Turn email or push on or off per event, and whether the caller hears about the " +
          "work of the teams they administer. Choices not in the body stay as they are.",
        tags: ["Workspaces"],
        body: channelsBody,
        response: { 200: AnyResponse, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      await updateChannelChoices(userId, req.body);
      return reply.send(await channelsView(userId));
    },
  );

  app.get(
    "/api/notifications/smtp",
    {
      ...admin,
      schema: {
        operationId: "getSmtpSettings",
        summary: "The SMTP relay",
        description:
          "Where Optio's email goes out: the settings saved in the app, else the deployment's " +
          "OPTIO_SMTP_URL. Never returns the password. Deployment admins only.",
        tags: ["Workspaces"],
        response: { 200: AnyResponse, 403: ErrorResponseSchema },
      },
    },
    async (_req, reply) => reply.send({ settings: await smtpSettingsView() }),
  );

  app.put(
    "/api/notifications/smtp",
    {
      ...admin,
      schema: {
        operationId: "saveSmtpSettings",
        summary: "Save the SMTP relay",
        description:
          "Save the relay in the app (it wins over OPTIO_SMTP_URL). A blank password keeps " +
          "the saved one; null clears it. Deployment admins only.",
        tags: ["Workspaces"],
        body: smtpBody,
        response: { 200: AnyResponse, 400: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const settings = await saveSmtpSettings(req.body, req.user?.id ?? null);
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "notify.smtp.update",
          params: { host: settings.host },
          result: { enabled: settings.enabled, insecureSkipVerify: settings.insecureSkipVerify },
          success: true,
        }).catch(() => {});
        return reply.send({ settings });
      } catch (err) {
        return sendConfigError(reply, err);
      }
    },
  );

  app.delete(
    "/api/notifications/smtp",
    {
      ...admin,
      schema: {
        operationId: "deleteSmtpSettings",
        summary: "Forget the app's SMTP relay",
        description:
          "Remove the relay saved in the app; the deployment's OPTIO_SMTP_URL applies again, " +
          "or no email goes out. Deployment admins only.",
        tags: ["Workspaces"],
        response: { 200: AnyResponse, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const settings = await deleteSmtpSettings();
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "notify.smtp.delete",
        success: true,
      }).catch(() => {});
      return reply.send({ settings });
    },
  );

  app.post(
    "/api/notifications/smtp/test",
    {
      ...admin,
      schema: {
        operationId: "sendTestEmail",
        summary: "Send a test email",
        description:
          "Send a test email through the saved relay, or through `settings` before saving " +
          "them, to `to` or the caller's own address. Answers 200 with `ok: false` and the " +
          "relay's reason when it fails. Deployment admins only.",
        tags: ["Workspaces"],
        body: testBody,
        response: { 200: AnyResponse, 400: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      let to = req.body.to?.trim() ?? "";
      let sentBy: string | null = null;
      if (req.user?.id) {
        const [me] = await db
          .select({ email: users.email, displayName: users.displayName })
          .from(users)
          .where(eq(users.id, req.user.id));
        sentBy = me ? `${me.displayName} <${me.email}>` : null;
        if (!to) to = me?.email ?? "";
      }
      if (!isEmailAddress(to)) {
        return reply.status(400).send({ error: "Give an address to send the test email to" });
      }
      let config;
      try {
        config = req.body.settings ? await configFromInput(req.body.settings) : undefined;
      } catch (err) {
        return sendConfigError(reply, err);
      }
      const email = renderTestEmail(sentBy);
      const result = await sendEmail(
        {
          to: [to],
          subject: email.subject,
          text: email.text,
          headers: { "X-Optio-Event": "test" },
        },
        config ? { config } : {},
      );
      return reply.send(
        result.ok
          ? { ok: true, to, response: result.response }
          : { ok: false, to, error: result.error },
      );
    },
  );
}
