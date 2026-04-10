import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as secretService from "../services/secret-service.js";
import { requireRole } from "../plugins/auth.js";
import { invalidateCredentialsCache } from "../services/auth-service.js";
import { publishEvent } from "../services/event-bus.js";

const scopeQuerySchema = z.object({ scope: z.string().optional() });
const nameParamsSchema = z.object({ name: z.string() });

const createSecretSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  scope: z.string().optional(),
});

/** Secret names that are auth-related and should trigger validation + cache invalidation. */
const AUTH_SECRET_NAMES = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);

/**
 * Best-effort validation probe for auth tokens.
 * Returns { valid, error? } — never throws.
 */
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
      // Non-auth errors (429, 500) — don't treat as invalid
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
    // Network error — don't block, treat as valid (best-effort)
    return { valid: true };
  }

  return { valid: true };
}

export async function secretRoutes(app: FastifyInstance) {
  // List secrets (names only) — any workspace member can view
  app.get("/api/secrets", async (req, reply) => {
    const query = scopeQuerySchema.parse(req.query);
    const workspaceId = req.user?.workspaceId ?? null;
    const secrets = await secretService.listSecrets(query.scope, workspaceId);
    reply.send({ secrets });
  });

  // Create/update secret — admin only
  app.post("/api/secrets", { preHandler: [requireRole("admin")] }, async (req, reply) => {
    const input = createSecretSchema.parse(req.body);
    const workspaceId = req.user?.workspaceId ?? null;
    await secretService.storeSecret(input.name, input.value, input.scope, workspaceId);

    const isAuthSecret = AUTH_SECRET_NAMES.has(input.name);
    let validation: { valid: boolean; error?: string } | undefined;

    if (isAuthSecret) {
      // Invalidate cached credentials so the next read picks up the new value
      invalidateCredentialsCache();

      // Run best-effort validation probe
      validation = await validateAuthToken(input.name, input.value);

      // Publish WebSocket event so the UI immediately re-fetches auth status.
      // The watermark in the failure detector ensures old failures are ignored.
      await publishEvent({
        type: "auth:status_changed",
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }

    reply.status(201).send({
      name: input.name,
      scope: input.scope ?? "global",
      ...(validation ? { validation } : {}),
    });
  });

  // Delete secret — admin only
  app.delete("/api/secrets/:name", { preHandler: [requireRole("admin")] }, async (req, reply) => {
    const { name } = nameParamsSchema.parse(req.params);
    const query = scopeQuerySchema.parse(req.query);
    const workspaceId = req.user?.workspaceId ?? null;
    await secretService.deleteSecret(name, query.scope, workspaceId);
    reply.status(204).send();
  });
}
