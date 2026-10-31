import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireRole } from "../plugins/auth.js";
import { ModelProviderError } from "../services/model-provider-service.js";
import {
  setDefaultGateway,
  storeOrganizationGatewayToken,
  storePersonalGatewayToken,
  syncGatewayCatalog,
  testGateway,
  viewerGatewayStatus,
  viewerGatewayUsage,
} from "../services/model-gateway-service.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { providerViewer } from "./model-providers.js";
import { gatewayKeyRoutes } from "./gateway-keys.js";

/**
 * The model gateway's own routes (docs/model-gateway.md): the catalog sync
 * and the connection test on a gateway provider, the viewer's token and the
 * organization's (Settings → My tokens) and a workspace's default gateway.
 * The provider CRUD itself is `routes/model-providers.ts`. Gateway tokens
 * are written only here, as `gateway:<providerId>` bound to the gateway's
 * URLs; `POST /api/secrets` refuses that name.
 */

const idParams = z.object({ id: z.string().uuid() });

const testBodySchema = z
  .object({ token: z.string().max(4096).optional() })
  .describe("A token to try; absent = the caller's own (or the gateway's stored one)");

const tokenBodySchema = z.object({ token: z.string().min(1).max(4096) });

const myTokenBodySchema = tokenBodySchema.extend({
  providerId: z
    .string()
    .uuid()
    .optional()
    .describe("The gateway the token is for; absent = the workspace's default"),
});

const TokenStoredSchema = z.object({
  providerId: z.string(),
  test: z.object({ ok: z.boolean(), modelCount: z.number(), error: z.string().optional() }),
});

const defaultGatewayBodySchema = z.object({
  providerId: z.string().uuid().nullable().describe("A gateway of the workspace; null clears"),
});

const TestResultSchema = z.object({
  ok: z.boolean(),
  modelCount: z.number(),
  error: z.string().optional(),
  tokenFrom: z.enum(["given", "stored", "personal"]),
});

const KeyInfoSchema = z
  .object({
    spend: z.number(),
    maxBudget: z.number().nullable(),
    budgetResetAt: z.string().nullable(),
    keyAlias: z.string().nullable(),
  })
  .nullable();

const GatewayMeSchema = z.object({
  gateway: z
    .object({
      id: z.string(),
      name: z.string(),
      baseUrl: z.string(),
      authHeader: z.enum(["bearer", "api-key"]),
      tokenSource: z.enum(["personal", "stored"]),
    })
    .nullable(),
  hasToken: z.boolean(),
  keyInfo: KeyInfoSchema,
  orgHasToken: z.boolean(),
});

const TokenUsageSchema = z.object({ hasToken: z.boolean(), keyInfo: KeyInfoSchema });

const GatewayUsageSchema = z.object({
  gateway: z.object({ id: z.string(), name: z.string(), baseUrl: z.string() }).nullable(),
  personal: TokenUsageSchema,
  organization: TokenUsageSchema,
});

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof ModelProviderError) {
    return reply.status(err.status).send({ error: err.message });
  }
  throw err;
}

export async function modelGatewayRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/model-providers/:id/sync",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "syncModelGateway",
        summary: "Sync a model gateway's catalog",
        description:
          "Read what the gateway serves with the organization's token (or the caller's) and " +
          "merge it into the catalog — LiteLLM's `/model/info` and `/v1/models`, a generic " +
          "gateway's `/v1/models`: limits and prices where the gateway reports them, names, " +
          "efforts and roles as the admin set them; models it stopped serving are flagged " +
          "`missing`.",
        tags: ["Setup & Settings"],
        params: idParams,
        response: {
          200: z.object({
            provider: z.unknown(),
            synced: z.object({ models: z.number(), missing: z.number() }),
          }),
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await syncGatewayCatalog(req.params.id, providerViewer(req));
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "model_provider.sync",
          params: { id: req.params.id },
          result: result.synced,
          success: true,
        }).catch(() => {});
        return reply.send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/api/model-providers/:id/test",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "testModelGateway",
        summary: "Test a model gateway",
        description:
          "Call the gateway's `/v1/models` with the given token, else the caller's own " +
          "(Settings → My tokens) or the gateway's stored one. Answers whether it worked " +
          "and how many models the token sees.",
        tags: ["Setup & Settings"],
        params: idParams,
        body: testBodySchema,
        response: {
          200: TestResultSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(await testGateway(req.params.id, providerViewer(req), req.body.token));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/api/gateway/me",
    {
      schema: {
        operationId: "getMyGatewayStatus",
        summary: "The viewer's standing with the default model gateway",
        description:
          "The workspace's default gateway, whether the viewer has their own token for it " +
          "(and the gateway's budget for that token, where it reports one), and whether the " +
          "organization has one.",
        tags: ["Setup & Settings"],
        response: { 200: GatewayMeSchema },
      },
    },
    async (req, reply) => {
      const status = await viewerGatewayStatus(providerViewer(req));
      return reply.send(status);
    },
  );

  app.get(
    "/api/gateway/me/usage",
    {
      schema: {
        operationId: "getMyGatewayUsage",
        summary: "The gateway's budgets for the viewer's tokens",
        description:
          "The gateway's own budget (spend, budget, reset: LiteLLM `/key/info`) for the " +
          "viewer's own token on the default gateway and for the organization's (admins). " +
          "Stands in for the Claude.ai usage limits in a gateway-only deployment.",
        tags: ["Setup & Settings"],
        response: { 200: GatewayUsageSchema },
      },
    },
    async (req, reply) => {
      const usage = await viewerGatewayUsage(providerViewer(req));
      return reply.send(usage);
    },
  );

  app.put(
    "/api/gateway/me/token",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "setMyGatewayToken",
        summary: "Store the viewer's own gateway token",
        description:
          "Saves the token as the viewer's private secret `gateway:<providerId>` for the named " +
          "gateway (else the workspace's default), bound to the gateway's current URLs, and " +
          "tries it against the gateway. The token is stored even when the test fails, so it " +
          "can be fixed on the gateway side. Runs map it to the env name the agent CLI reads " +
          "only at launch.",
        tags: ["Setup & Settings"],
        body: myTokenBodySchema,
        response: {
          200: TokenStoredSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const stored = await storePersonalGatewayToken(
          providerViewer(req),
          req.body.token,
          req.body.providerId,
        );
        return reply.send(stored);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put(
    "/api/model-providers/:id/token",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "setOrganizationGatewayToken",
        summary: "Store the organization's token for a gateway",
        description:
          "Saves the token the organization's work on this gateway runs with, as the secret " +
          "`gateway:<id>` in the gateway's workspace, bound to the gateway's current URLs, and " +
          "tries it. Admins only; a person's own gateway has none.",
        tags: ["Setup & Settings"],
        params: idParams,
        body: tokenBodySchema,
        response: {
          200: TokenStoredSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const stored = await storeOrganizationGatewayToken(
          req.params.id,
          providerViewer(req),
          req.body.token,
        );
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "model_provider.organization_token",
          params: { id: req.params.id },
          result: { ok: stored.test.ok },
          success: true,
        }).catch(() => {});
        return reply.send(stored);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put(
    "/api/workspaces/:id/default-gateway",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "setWorkspaceDefaultGateway",
        summary: "Pick the workspace's default model gateway",
        description:
          "The gateway Settings → My tokens shows and, in a gateway-only deployment, the one " +
          "work runs through when it picks none (`providerId` null clears it; the " +
          "organization's first gateway then stands in). Admins only.",
        tags: ["Setup & Settings"],
        params: idParams,
        body: defaultGatewayBodySchema,
        response: {
          200: z.object({ defaultModelProviderId: z.string().nullable() }),
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const row = await setDefaultGateway(
          req.params.id,
          req.body.providerId,
          providerViewer(req),
        );
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "workspace.default_gateway",
          params: { providerId: req.body.providerId },
          result: { defaultModelProviderId: row?.id ?? null },
          success: true,
        }).catch(() => {});
        return reply.send({ defaultModelProviderId: row?.id ?? null });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  await gatewayKeyRoutes(rawApp);
}
