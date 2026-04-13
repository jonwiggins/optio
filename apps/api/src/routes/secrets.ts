import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as secretService from "../services/secret-service.js";
import { requireRole } from "../plugins/auth.js";
import { invalidateCredentialsCache } from "../services/auth-service.js";
import { publishEvent } from "../services/event-bus.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";

const scopeQuerySchema = z
  .object({
    scope: z.string().optional().describe("Optional scope filter (e.g. `global`, `repo`)"),
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
    scope: z.string().optional().describe("Optional scope; defaults to `global`"),
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
      const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${value}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
      if (res.ok) return { valid: true };
      if (res.status === 401) return { valid: false, error: "OAuth token is invalid or expired" };
      return { valid: true };
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

export async function secretRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/secrets",
    {
      schema: {
        operationId: "listSecrets",
        summary: "List secrets",
        description:
          "Return secret names (not values) in the current workspace. Any member can view.",
        tags: ["Setup & Settings"],
        querystring: scopeQuerySchema,
        response: { 200: SecretsListResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const secrets = await secretService.listSecrets(req.query.scope, workspaceId);
      reply.send({ secrets });
    },
  );

  app.post(
    "/api/secrets",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "createOrUpdateSecret",
        summary: "Create or update a secret",
        description:
          "Store a secret (encrypted at rest). Auth tokens " +
          "(`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`) " +
          "trigger a best-effort validation probe, credential cache " +
          "invalidation, and a WebSocket `auth:status_changed` event so the " +
          "UI picks up the change immediately. Requires `admin` role.",
        tags: ["Setup & Settings"],
        body: createSecretSchema,
        response: { 201: SecretCreatedResponseSchema },
      },
    },
    async (req, reply) => {
      const input = req.body;
      const workspaceId = req.user?.workspaceId ?? null;
      await secretService.storeSecret(input.name, input.value, input.scope, workspaceId);

      const isAuthSecret = AUTH_SECRET_NAMES.has(input.name);
      let validation: { valid: boolean; error?: string } | undefined;

      if (isAuthSecret) {
        invalidateCredentialsCache();
        validation = await validateAuthToken(input.name, input.value);
        await publishEvent({
          type: "auth:status_changed",
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      logAction({
        userId: req.user?.id,
        action: "secret.upsert",
        params: { name: input.name, scope: input.scope ?? "global" },
        result: { name: input.name },
        success: true,
      }).catch(() => {});
      reply.status(201).send({
        name: input.name,
        scope: input.scope ?? "global",
        ...(validation ? { validation } : {}),
      });
    },
  );

  app.delete(
    "/api/secrets/:name",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "deleteSecret",
        summary: "Delete a secret",
        description: "Delete a secret by name. Requires `admin` role. Returns 204 on success.",
        tags: ["Setup & Settings"],
        params: nameParamsSchema,
        querystring: scopeQuerySchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { name } = req.params;
      const workspaceId = req.user?.workspaceId ?? null;
      await secretService.deleteSecret(name, req.query.scope, workspaceId);
      logAction({
        userId: req.user?.id,
        action: "secret.delete",
        params: { name },
        result: { name },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );
}
