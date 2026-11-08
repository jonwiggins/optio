import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireDeploymentAdmin } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { logAction } from "../services/optio-action-service.js";
import {
  findAccountsByEmail,
  listUserCredentials,
  revokeAllUserSessions,
  revokeUserApiKey,
  revokeUserSession,
} from "../services/user-credentials-service.js";

/**
 * A person's sessions and API keys, for a deployment admin (Settings →
 * Access → Sessions and API keys): find the person by email, see what can
 * still sign in as them, and end one session, all of them, or one API key
 * without disabling the account. Every revocation goes in the action log
 * (`user_credentials.*`), naming the account and the session or key (a key
 * by its prefix), never a token.
 */

const Timestamp = z.string().describe("ISO-8601");
const NullableTimestamp = Timestamp.nullable();

const AccountCredentialsSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    provider: z.string(),
    lastLoginAt: Timestamp,
  }),
  sessions: z
    .array(
      z.object({
        id: z.string(),
        createdAt: Timestamp,
        lastSeenAt: NullableTimestamp.describe("Last used; null: not since before it was tracked"),
        expiresAt: Timestamp,
      }),
    )
    .describe("Sign-in sessions that still work"),
  apiKeys: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        prefix: z.string().describe("The key's first characters, to recognize it"),
        createdAt: Timestamp,
        lastUsedAt: NullableTimestamp,
        expiresAt: NullableTimestamp.describe("null: never"),
      }),
    )
    .describe("API keys not revoked (an expired one is listed with its expiry)"),
});

const LookupResponseSchema = z
  .object({ accounts: z.array(AccountCredentialsSchema) })
  .describe("The accounts with that email, each with its sessions and API keys");

const UserParams = z.object({ userId: z.string().uuid() });
const SessionParams = UserParams.extend({ sessionId: z.string().uuid() });
const KeyParams = UserParams.extend({ keyId: z.string().uuid() });
const OkSchema = z.object({ ok: z.boolean() });
const CountSchema = z.object({ revoked: z.number().int().describe("Sessions ended") });

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function userCredentialRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  const audit = async (
    req: FastifyRequest,
    action: string,
    params: Record<string, unknown>,
    result: Record<string, unknown>,
  ) => {
    // Awaited: the revocation is done either way, but its record should
    // not be dropped silently.
    await logAction({
      workspaceId: null,
      userId: req.user?.id,
      action,
      params,
      result,
      success: true,
    }).catch((err) => req.log.warn({ err, action }, "could not record a credential revocation"));
  };

  app.get(
    "/api/admin/user-credentials",
    {
      preHandler: [requireDeploymentAdmin],
      schema: {
        operationId: "listUserCredentials",
        summary: "A person's sessions and API keys",
        description:
          "Deployment admins only. The accounts with this email, each with its sign-in " +
          "sessions that still work and its API keys that aren't revoked. Never returns a token.",
        tags: ["Auth & Sessions"],
        querystring: z.object({ email: z.string().trim().min(3).max(320) }),
        response: { 200: LookupResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const accounts = await findAccountsByEmail(req.query.email);
      const out = await Promise.all(
        accounts.map(async (account) => {
          const { sessions, apiKeys } = await listUserCredentials(account.id);
          return {
            user: { ...account, lastLoginAt: account.lastLoginAt.toISOString() },
            sessions: sessions.map((s) => ({
              id: s.id,
              createdAt: s.createdAt.toISOString(),
              lastSeenAt: iso(s.lastSeenAt),
              expiresAt: s.expiresAt.toISOString(),
            })),
            apiKeys: apiKeys.map((k) => ({
              id: k.id,
              name: k.name,
              prefix: k.prefix,
              createdAt: k.createdAt.toISOString(),
              lastUsedAt: iso(k.lastUsedAt),
              expiresAt: iso(k.expiresAt),
            })),
          };
        }),
      );
      reply.send({ accounts: out });
    },
  );

  app.delete(
    "/api/admin/users/:userId/sessions/:sessionId",
    {
      preHandler: [requireDeploymentAdmin],
      schema: {
        operationId: "revokeUserSession",
        summary: "End one of a person's sessions",
        description: "Deployment admins only. Signs that browser out; the account stays enabled.",
        tags: ["Auth & Sessions"],
        params: SessionParams,
        response: {
          200: OkSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { userId, sessionId } = req.params;
      if (!(await revokeUserSession(userId, sessionId)))
        return reply.status(404).send({ error: "Session not found" });
      await audit(req, "user_credentials.session_revoked", { id: sessionId }, { userId });
      reply.send({ ok: true });
    },
  );

  app.delete(
    "/api/admin/users/:userId/sessions",
    {
      preHandler: [requireDeploymentAdmin],
      schema: {
        operationId: "revokeAllUserSessions",
        summary: "End all of a person's sessions",
        description:
          "Deployment admins only. Signs the person out everywhere; the account stays " +
          "enabled and its API keys keep working.",
        tags: ["Auth & Sessions"],
        params: UserParams,
        response: { 200: CountSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const revoked = await revokeAllUserSessions(req.params.userId);
      await audit(
        req,
        "user_credentials.sessions_revoked",
        { count: revoked },
        { userId: req.params.userId },
      );
      reply.send({ revoked });
    },
  );

  app.delete(
    "/api/admin/users/:userId/api-keys/:keyId",
    {
      preHandler: [requireDeploymentAdmin],
      schema: {
        operationId: "revokeUserApiKey",
        summary: "Revoke one of a person's API keys",
        description: "Deployment admins only. The key stops working; the account stays enabled.",
        tags: ["Auth & Sessions"],
        params: KeyParams,
        response: {
          200: OkSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { userId, keyId } = req.params;
      const prefix = await revokeUserApiKey(userId, keyId);
      if (prefix === null) return reply.status(404).send({ error: "API key not found" });
      await audit(req, "user_credentials.api_key_revoked", { id: keyId }, { userId, prefix });
      reply.send({ ok: true });
    },
  );
}
