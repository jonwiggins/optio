import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { MODEL_PROVIDER_AGENTS, MODEL_PROVIDER_POD_CREDENTIALS } from "@optio/shared";
import { requireRole } from "../plugins/auth.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import {
  ModelProviderError,
  createModelProvider,
  deleteModelProvider,
  listModelProviders,
  updateModelProvider,
  type ProviderViewer,
} from "../services/model-provider-service.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";

const modelSchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().max(100).optional(),
});

const modelsSchema = z
  .object({
    "claude-code": z.array(modelSchema).max(50).optional(),
    codex: z.array(modelSchema).max(50).optional(),
  })
  .describe("Models offered per agent, in picker order (first = default)");

const credentialsSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("access-key"),
      accessKeyId: z.string().min(1).max(128),
      secretAccessKey: z.string().min(1).max(256),
      sessionToken: z.string().max(4096).optional(),
    }),
    z.object({ type: z.literal("bearer-token"), bearerToken: z.string().min(1).max(4096) }),
  ])
  .describe("Pod credentials (write-only; never returned)");

const agentsSchema = z.array(z.enum(MODEL_PROVIDER_AGENTS)).min(1);
const podCredentialSchema = z.enum(
  MODEL_PROVIDER_POD_CREDENTIALS as unknown as [string, ...string[]],
) as z.ZodType<(typeof MODEL_PROVIDER_POD_CREDENTIALS)[number]>;

const createSchema = z
  .object({
    name: z.string().min(1).max(100),
    owner: z.enum(["workspace", "me"]),
    kind: z.literal("bedrock"),
    agents: agentsSchema,
    region: z.string().min(1).max(40),
    models: modelsSchema.optional(),
    localAwsProfile: z.string().max(64).nullable().optional(),
    podCredential: podCredentialSchema.optional(),
    credentials: credentialsSchema.nullable().optional(),
  })
  .describe("Body for creating a model provider");

const updateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    owner: z.enum(["workspace", "me"]).optional(),
    agents: agentsSchema.optional(),
    region: z.string().min(1).max(40).optional(),
    models: modelsSchema.optional(),
    localAwsProfile: z.string().max(64).nullable().optional(),
    podCredential: podCredentialSchema.optional(),
    credentials: credentialsSchema.nullable().optional(),
  })
  .describe("Body for updating a model provider (absent fields are kept)");

const idParams = z.object({ id: z.string().uuid() });
const ProviderResponse = z.object({ provider: z.unknown() });

export function providerViewer(req: FastifyRequest): ProviderViewer {
  return {
    workspaceId: req.user?.workspaceId ?? null,
    userId: req.user?.id ?? null,
    isAdmin: isAuthDisabled() || req.user?.workspaceRole === "admin",
  };
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof ModelProviderError) {
    return reply.status(err.status).send({ error: err.message });
  }
  throw err;
}

export async function modelProviderRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/model-providers",
    {
      schema: {
        operationId: "listModelProviders",
        summary: "List model providers",
        description:
          "The organization's model providers (Amazon Bedrock for Claude Code / Codex) and " +
          "the caller's own. Admins also see other members' personal ones, read-only. " +
          "Stored credentials are never returned.",
        tags: ["Setup & Settings"],
        response: { 200: z.object({ providers: z.array(z.unknown()) }) },
      },
    },
    async (req, reply) => {
      reply.send({ providers: await listModelProviders(providerViewer(req)) });
    },
  );

  app.post(
    "/api/model-providers",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createModelProvider",
        summary: "Add a model provider",
        description:
          "`owner: workspace` (the organization's) requires admin; `owner: me` makes it " +
          "personal: only work the caller owns can use it.",
        tags: ["Setup & Settings"],
        body: createSchema,
        response: { 201: ProviderResponse, 400: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const provider = await createModelProvider(req.body, providerViewer(req));
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "model_provider.create",
          params: { name: provider.name, owner: req.body.owner },
          result: { id: provider.id },
          success: true,
        }).catch(() => {});
        return reply.status(201).send({ provider });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.patch(
    "/api/model-providers/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "updateModelProvider",
        summary: "Change a model provider",
        description:
          "Owners change their personal providers; admins the organization's. " +
          "`credentials: null` clears the stored pod credentials; absent keeps them.",
        tags: ["Setup & Settings"],
        params: idParams,
        body: updateSchema,
        response: {
          200: ProviderResponse,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const provider = await updateModelProvider(req.params.id, req.body, providerViewer(req));
        return reply.send({ provider });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/api/model-providers/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deleteModelProvider",
        summary: "Remove a model provider",
        description:
          "Work that picked it falls back to failing with a clear error until it picks another.",
        tags: ["Setup & Settings"],
        params: idParams,
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        await deleteModelProvider(req.params.id, providerViewer(req));
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "model_provider.delete",
          params: { id: req.params.id },
          result: {},
          success: true,
        }).catch(() => {});
        return reply.status(204).send(null);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
