import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as secretService from "../services/secret-service.js";
import { actorOf } from "../services/ownership.js";
import { requireRole } from "../plugins/auth.js";
import { invalidateCredentialsCache } from "../services/auth-service.js";
import { publishEvent } from "../services/event-bus.js";
import { logAction } from "../services/optio-action-service.js";
import {
  GLOBAL_SECRET_REFUSAL,
  globalSecretsNeedDeploymentAdmin,
  isGlobalSecretScope,
  refuseUnlessDeploymentAdmin,
} from "../services/deployment-admin-gates.js";
import { teamsEnabled } from "../services/deployment-settings.js";
import { TEAMS_OFF_MESSAGE } from "../services/team-service.js";
import { auditTokenSecret } from "../services/audit.js";
import { pastedTokenRefusal } from "../services/gateway-keys.js"; // gateway keys
import { ErrorResponseSchema, ResourceOwnerSchema } from "../schemas/common.js";

const scopeQuerySchema = z
  .object({
    scope: z.string().optional().describe("Optional scope filter (e.g. `global`, `repo`, `user`)"),
    deployment: z
      .enum(["0", "1"])
      .optional()
      .describe(
        "`1`: only the deployment's own secrets (identity tokens, Optio settings, git sign-in); " +
          "`0`: everything but those; unset: all",
      ),
    userId: z
      .string()
      .uuid()
      .optional()
      .describe("Admins only, with `scope=user`: the owner of the private secret to delete"),
    teamId: z.string().uuid().optional().describe("With `scope=team`: the team"),
  })
  .describe("Query parameters for scope-filtering");

const nameParamsSchema = z
  .object({
    name: z.string().describe("Secret name"),
  })
  .describe("Path parameters: secret name");

const createSecretSchema = z
  .object({
    name: z.string().min(1).describe("Secret name (uppercase env-var style)"),
    value: z.string().min(1).describe("Secret value (encrypted at rest)"),
    scope: z
      .string()
      .optional()
      .describe(
        "Optional scope; defaults to `global`. Use `user` for per-user secrets, `team` (with " +
          "`teamId`) for a team's.",
      ),
    teamId: z.string().uuid().optional().describe("With `scope: team`: the team"),
  })
  .describe("Body for creating/updating a secret");

const SecretsListResponseSchema = z.object({ secrets: z.unknown() });
const SecretCreatedResponseSchema = z.object({
  name: z.string(),
  scope: z.string(),
  validation: z
    .object({
      valid: z.boolean(),
      error: z.string().optional(),
    })
    .optional(),
});

/** Secret names that are auth-related and should trigger validation + cache invalidation. */
const AUTH_SECRET_NAMES = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);

async function validateAuthToken(
  name: string,
  value: string,
): Promise<{ valid: boolean; error?: string }> {
  try {
    if (name === "GITHUB_TOKEN") {
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `token ${value}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (res.ok) return { valid: true };
      const body = await res.json().catch(() => ({}));
      return { valid: false, error: body.message ?? `GitHub API returned ${res.status}` };
    }

    if (name === "CLAUDE_CODE_OAUTH_TOKEN") {
      // Same check as the periodic worker, so a revoked token that only draws
      // 429s from the usage endpoint is still caught.
      const { validateClaudeToken } = await import("../workers/token-validation-worker.js");
      return await validateClaudeToken(value);
    }

    if (name === "ANTHROPIC_API_KEY") {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": value,
          "anthropic-version": "2023-06-01",
        },
      });
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: "API key is invalid" };
      return { valid: true };
    }
  } catch {
    return { valid: true };
  }

  return { valid: true };
}

/**
 * Org-level secrets need an admin; a member manages their own (`scope: user`);
 * a team's admins manage the team's (`scope: team`).
 */
const scopeOnlySchema = z
  .object({ scope: z.string().optional(), teamId: z.string().optional() })
  .passthrough();

async function requireAdminUnlessUserScope(req: FastifyRequest, reply: FastifyReply) {
  const body = scopeOnlySchema.safeParse(req.body ?? {});
  const query = scopeOnlySchema.safeParse(req.query ?? {});
  const scope =
    (body.success ? body.data.scope : undefined) ?? (query.success ? query.data.scope : undefined);
  if (scope === "user" && req.user?.id) return;
  if (scope === "team") {
    if (!(await teamsEnabled())) return reply.status(400).send({ error: TEAMS_OFF_MESSAGE });
    const teamId =
      (body.success ? body.data.teamId : undefined) ??
      (query.success ? query.data.teamId : undefined);
    if (!teamId) return reply.status(400).send({ error: "teamId is required for a team secret" });
    if (req.user?.adminTeamIds?.includes(teamId)) return;
    if (!req.user?.teamIds?.includes(teamId) && req.user?.workspaceRole !== "admin") {
      return reply.status(403).send({ error: "You're not a member of that team" });
    }
    if (req.user?.workspaceRole === "admin") return;
    return reply.status(403).send({ error: "Only the team's admins can change its secrets" });
  }
  // A global secret is the deployment's, not one workspace's, when the
  // deployment says so (deployment-admin-gates.ts).
  if (isGlobalSecretScope(scope) && (await globalSecretsNeedDeploymentAdmin())) {
    return refuseUnlessDeploymentAdmin(req, reply, GLOBAL_SECRET_REFUSAL);
  }
  return requireRole("admin")(req, reply);
}

export async function secretRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/secrets",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "listSecrets",
        summary: "List secrets",
        description:
          "Return secret names (not values) in the current workspace. " +
          "Includes the caller's user-scoped secrets plus workspace global/repo secrets. " +
          "Any member can view.",
        tags: ["Setup & Settings"],
        querystring: scopeQuerySchema,
        response: { 200: SecretsListResponseSchema },
      },
    },
    async (req, reply) => {
      // The organization's secrets, the caller's private ones and — for an
      // admin — other members' private ones by name (`ownerUserId`,
      // `ownerName` say whose). See services/ownership.ts.
      const all = await secretService.listVisibleSecrets(actorOf(req), req.query.scope);
      const secrets =
        req.query.deployment === "1"
          ? all.filter((s) => secretService.isDeploymentSecret(s.name))
          : req.query.deployment === "0"
            ? all.filter((s) => !secretService.isDeploymentSecret(s.name))
            : all;
      reply.send({ secrets });
    },
  );

  app.get(
    "/api/secrets/pickable",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "listPickableSecrets",
        summary: "Secrets work can pick",
        description:
          "Names (never values) of the secrets a piece of work can give its pod: the " +
          "organization's (`owner: workspace`) and the caller's own (`owner: me`).",
        tags: ["Setup & Settings"],
        response: {
          200: z.object({
            secrets: z.array(z.object({ name: z.string(), owner: ResourceOwnerSchema })),
          }),
        },
      },
    },
    async (req, reply) => {
      const secrets = await secretService.listPickableSecrets(
        req.user?.workspaceId ?? null,
        req.user?.id ?? null,
        req.user?.teamIds ?? [],
      );
      reply.send({ secrets });
    },
  );

  app.post(
    "/api/secrets",
    {
      // Members may store their own (`scope: user`) secrets; the rest need an admin.
      preHandler: [requireRole("member"), requireAdminUnlessUserScope],
      schema: {
        operationId: "createOrUpdateSecret",
        summary: "Create or update a secret",
        description:
          "Store a secret (encrypted at rest). Auth tokens " +
          "(`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`) " +
          "trigger a best-effort validation probe, credential cache " +
          "invalidation, and a WebSocket `auth:status_changed` event so the " +
          "UI picks up the change immediately. Use `scope: 'user'` for " +
          "per-user identity tokens. Requires `admin` role (or any role for " +
          "user-scoped secrets).",
        tags: ["Setup & Settings"],
        body: createSecretSchema,
        response: { 201: SecretCreatedResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const input = req.body;
      const workspaceId = req.user?.workspaceId ?? null;
      const userId = req.user?.id ?? null;

      // User-scoped secrets need a caller. In auth-disabled local dev there's
      // no user, so silently downgrade to global — there's no multi-user
      // separation to preserve anyway. Treat omitted scope as "global" up
      // front so the workspaceId-stripping rule below applies uniformly.
      const requestedScope = input.scope ?? "global";
      const effectiveScope = requestedScope === "user" && !userId ? "global" : requestedScope;
      const effectiveUserId = effectiveScope === "user" ? userId : null;
      // "global" scope must not carry a workspaceId — see issue #509. The
      // request always has the caller's current workspaceId, but for a
      // global write we drop it so the row is genuinely workspace-agnostic.
      // A private ("user") secret is a person's, not a workspace's: it is
      // stored (and encrypted) without one too, or run-time lookups by user
      // could never decrypt it. A team's secret is its workspace's.
      const effectiveWorkspaceId =
        effectiveScope === "global" || effectiveScope === "user" ? null : workspaceId;
      const effectiveTeamId = effectiveScope === "team" ? (input.teamId ?? null) : null;

      // A gateway that takes only keys Optio makes refuses a pasted one (gateway-keys.ts).
      const refusal = await pastedTokenRefusal(input.name, effectiveScope, workspaceId);
      if (refusal) return reply.status(400).send({ error: refusal });

      await secretService.storeSecret(
        input.name,
        input.value,
        effectiveScope,
        effectiveWorkspaceId,
        effectiveUserId,
        effectiveTeamId,
      );

      const isAuthSecret = AUTH_SECRET_NAMES.has(input.name);
      let validation: { valid: boolean; error?: string } | undefined;

      if (isAuthSecret) {
        invalidateCredentialsCache();
        validation = await validateAuthToken(input.name, input.value);
        // The global Claude token is what the worker's cached status describes:
        // record the fresh verdict now, or the "expired" banner outlives the fix.
        if (input.name === "CLAUDE_CODE_OAUTH_TOKEN" && effectiveScope === "global" && validation) {
          const { recordTokenValidation } = await import("../workers/token-validation-worker.js");
          await recordTokenValidation({
            valid: validation.valid,
            tokenExists: true,
            ...(validation.error ? { error: validation.error } : {}),
          }).catch(() => {});
        }
        await publishEvent({
          type: "auth:status_changed",
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "secret.upsert",
        params: { name: input.name, scope: effectiveScope },
        result: { name: input.name },
        success: true,
      }).catch(() => {});
      // A person's, a team's or the organization's token (docs/audit.md).
      void auditTokenSecret(req, "set", {
        name: input.name,
        scope: effectiveScope,
        teamId: effectiveTeamId,
      });
      reply.status(201).send({
        name: input.name,
        scope: effectiveScope,
        ...(validation ? { validation } : {}),
      });
    },
  );

  app.delete(
    "/api/secrets/:name",
    {
      preHandler: [requireRole("member"), requireAdminUnlessUserScope],
      schema: {
        operationId: "deleteSecret",
        summary: "Delete a secret",
        description:
          "Delete a secret by name. User-scoped secrets can only be deleted by their owner. " +
          "Requires `admin` role (or any role for user-scoped secrets). Returns 204 on success.",
        tags: ["Setup & Settings"],
        params: nameParamsSchema,
        querystring: scopeQuerySchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { name } = req.params;
      const workspaceId = req.user?.workspaceId ?? null;
      const userId = req.user?.id ?? null;
      const scope = req.query.scope;

      // A private secret is deleted by its owner — or, for offboarding, by an
      // admin naming the owner (`?userId=`). Anyone else's id is ignored.
      const actor = actorOf(req);
      const effectiveUserId =
        scope === "user" ? (actor.isAdmin && req.query.userId ? req.query.userId : userId) : null;

      await secretService.deleteSecret(
        name,
        scope,
        workspaceId,
        effectiveUserId,
        scope === "team" ? (req.query.teamId ?? null) : null,
      );
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "secret.delete",
        params: { name },
        result: { name },
        success: true,
      }).catch(() => {});
      // A person's, a team's or the organization's token (docs/audit.md).
      void auditTokenSecret(req, "delete", {
        name,
        scope,
        teamId: req.query.teamId,
        targetUserId: effectiveUserId,
      });
      reply.status(204).send(null);
    },
  );
}
