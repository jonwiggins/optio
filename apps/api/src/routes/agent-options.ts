import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ALL_PROVIDER_IDS, PROVIDER_CATALOGS, type AgentProviderId } from "@optio/shared";
import { getProviderOptions, invalidateProviderCache } from "../services/agent-options-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { ErrorResponseSchema } from "../schemas/common.js";

const providerParamsSchema = z.object({
  provider: z.enum(["anthropic", "openai", "gemini", "copilot", "opencode", "openclaw"]),
});

const refreshQuerySchema = z.object({
  refresh: z
    .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0")])
    .optional(),
});

const ProviderOptionsResponseSchema = z
  .object({
    provider: z.string(),
    source: z.enum(["baseline", "live"]),
    cached: z.boolean(),
    refreshedAt: z.number().nullable(),
    error: z.string().optional(),
    catalog: z.unknown(),
  })
  .describe("Provider options catalog, optionally augmented by a live probe");

const ProviderListResponseSchema = z
  .object({
    providers: z.array(z.unknown()),
  })
  .describe("All provider catalogs (hardcoded baseline only)");

const requireAdminWhenAuthenticated = async (req: FastifyRequest, reply: FastifyReply) => {
  if (isAuthDisabled()) return;
  if (!req.user) return;
  if (req.user.workspaceRole !== "admin") {
    return reply.status(403).send({
      error: "Admin role required for agent options refresh",
    });
  }
};

export async function agentOptionsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/agents/options",
    {
      schema: {
        operationId: "listAgentOptions",
        summary: "List hardcoded agent options for every provider",
        description:
          "Return the per-provider hardcoded catalog (models, aliases, options) " +
          "without consulting any upstream list-models API. Used by the UI on " +
          "first paint before a live refresh kicks in.",
        tags: ["Setup & Settings"],
        response: { 200: ProviderListResponseSchema },
      },
    },
    async (_req, reply) => {
      const providers = ALL_PROVIDER_IDS.map((id) => PROVIDER_CATALOGS[id]);
      reply.send({ providers });
    },
  );

  app.get(
    "/api/agents/:provider/options",
    {
      schema: {
        operationId: "getAgentProviderOptions",
        summary: "Get model & options for a specific agent provider",
        description:
          "Return the catalog for a single provider. If `refresh=true`, bypass " +
          "the Redis cache and reprobe the provider's list-models API. " +
          "Providers without a public list-models endpoint (Copilot, OpenCode, " +
          "OpenClaw) always return the hardcoded baseline.",
        tags: ["Setup & Settings"],
        params: providerParamsSchema,
        querystring: refreshQuerySchema,
        response: {
          200: ProviderOptionsResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const provider = req.params.provider as AgentProviderId;
      const forceRefresh = req.query.refresh === "true" || req.query.refresh === "1";

      if (forceRefresh) {
        await invalidateProviderCache(provider);
      }

      const workspaceId = req.user?.workspaceId ?? null;
      const result = await getProviderOptions(provider, {
        workspaceId,
        forceRefresh,
      });

      reply.send({
        provider,
        source: result.source,
        cached: result.cached,
        refreshedAt: result.refreshedAt,
        ...(result.error ? { error: result.error } : {}),
        catalog: result.catalog,
      });
    },
  );

  app.post(
    "/api/agents/:provider/options/refresh",
    {
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "refreshAgentProviderOptions",
        summary: "Invalidate the cache and reprobe a provider",
        description:
          "Admin-only shortcut for explicit refresh from the UI's Refresh " +
          "button. Equivalent to `GET /api/agents/:provider/options?refresh=true` " +
          "but always POST so browsers/proxies don't cache it.",
        tags: ["Setup & Settings"],
        params: providerParamsSchema,
        response: {
          200: ProviderOptionsResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const provider = req.params.provider as AgentProviderId;
      await invalidateProviderCache(provider);
      const workspaceId = req.user?.workspaceId ?? null;
      const result = await getProviderOptions(provider, {
        workspaceId,
        forceRefresh: true,
      });
      reply.send({
        provider,
        source: result.source,
        cached: result.cached,
        refreshedAt: result.refreshedAt,
        ...(result.error ? { error: result.error } : {}),
        catalog: result.catalog,
      });
    },
  );
}
