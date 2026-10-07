import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireRole } from "../plugins/auth.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { actorOf, type Actor } from "../services/ownership.js";
import {
  AgentCredentialError,
  createAgentCredential,
  listAgentCredentials,
  verifyAgentCredential,
} from "../services/agent-credential-service.js";
import { logAction } from "../services/optio-action-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";

const OwnerSchema = z.enum(["workspace", "me"]);
const MethodSchema = z.enum([
  "api-key",
  "oauth-token",
  "app-server",
  "github-token",
  "vertex-ai",
  "bedrock",
]);
const AgentTypeSchema = z.string().min(1).max(40);
const SecretNameSchema = z.string().min(1).max(100);

const CredentialSchema = z
  .object({
    id: z.string().describe("`secret:<id>` or `provider:<id>`"),
    kind: z.enum(["secret", "provider"]),
    method: MethodSchema,
    label: z.string(),
    secretName: z.string().nullable().optional(),
    providerId: z.string().nullable().optional(),
    owner: OwnerSchema,
    ownerUserId: z.string().nullable().optional(),
    ownerName: z.string().nullable().optional(),
    default: z.boolean().describe("What a run with no pick would use"),
    updatedAt: z.string().nullable().optional(),
  })
  .describe("One way the agent can sign in: a stored secret or a model provider");

const MethodOptionSchema = z.object({
  secretName: z.string(),
  method: MethodSchema,
  label: z.string(),
  input: z.enum(["token", "url", "project"]),
  verifiable: z.boolean(),
  hint: z.string().nullable().optional(),
});

const ListResponseSchema = z.object({
  credentials: z.array(CredentialSchema),
  addable: z.array(MethodOptionSchema),
});

const listQuerySchema = z.object({
  agentType: AgentTypeSchema.describe("The runtime, e.g. claude-code"),
  owner: OwnerSchema.default("workspace").describe("The owner the form shows for the work"),
});

const createBodySchema = z
  .object({
    agentType: AgentTypeSchema,
    secretName: SecretNameSchema,
    value: z.string().min(1).max(100_000).describe("Write-only; never returned"),
    owner: OwnerSchema.describe("`workspace` needs an admin; `me` any member"),
    verify: z
      .boolean()
      .optional()
      .describe("Check the value with the service first (default true)"),
  })
  .describe("Body for storing an agent credential");

const verifyBodySchema = z.object({
  agentType: AgentTypeSchema,
  secretName: SecretNameSchema,
  value: z.string().min(1).max(100_000),
});

const VerifyResponseSchema = z.object({
  valid: z.boolean(),
  error: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
});

/**
 * Who is asking. With auth disabled nobody is signed in, so nothing is
 * anyone's own: "me" is stored and listed as the organization's, the way
 * work and pod secrets behave there.
 */
function credentialActor(req: FastifyRequest): Actor {
  return actorOf(req);
}

function ownerFor(actor: Actor, requested: "workspace" | "me"): "workspace" | "me" {
  return requested === "me" && !actor.userId && isAuthDisabled() ? "workspace" : requested;
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof AgentCredentialError) {
    return reply.status(err.status).send({ error: err.message });
  }
  throw err;
}

export async function agentCredentialRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/agents/credentials",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "listAgentCredentials",
        summary: "List the sign-ins an agent can run with",
        description:
          "The credentials the Who section offers for the agent: the organization's stored " +
          "sign-in secrets of the agent's known names, the caller's own, and the model " +
          "providers that serve it. `default` marks what a run with no pick uses. Values are " +
          "never returned. `addable` lists what `POST /api/agents/credentials` can store.",
        tags: ["Setup & Settings"],
        querystring: listQuerySchema,
        response: { 200: ListResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = credentialActor(req);
      reply.send(
        await listAgentCredentials(actor, req.query.agentType, ownerFor(actor, req.query.owner)),
      );
    },
  );

  app.post(
    "/api/agents/credentials",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createAgentCredential",
        summary: "Store a sign-in for an agent",
        description:
          "Stores the value as the named secret — the organization's (admins only) or the " +
          "caller's own — replacing that owner's existing one, after checking it with the " +
          "service when it can be checked. Returns the credential as the list shows it.",
        tags: ["Setup & Settings"],
        body: createBodySchema,
        response: {
          201: z.object({ credential: CredentialSchema }),
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = credentialActor(req);
      try {
        const credential = await createAgentCredential(actor, {
          ...req.body,
          owner: ownerFor(actor, req.body.owner),
        });
        logAction({
          workspaceId: actor.workspaceId,
          userId: actor.userId ?? undefined,
          action: "agent_credential.create",
          params: {
            agentType: req.body.agentType,
            secretName: req.body.secretName,
            owner: req.body.owner,
          },
          result: { id: credential.id },
          success: true,
        });
        reply.status(201).send({ credential });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/api/agents/credentials/verify",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "verifyAgentCredential",
        summary: "Check a sign-in value without storing it",
        description:
          "Probes the service (Anthropic, OpenAI, Gemini, GitHub) with the value. Methods " +
          'that cannot be checked answer valid with `detail: "not checked"`.',
        tags: ["Setup & Settings"],
        body: verifyBodySchema,
        response: { 200: VerifyResponseSchema },
      },
    },
    async (req, reply) => {
      reply.send(await verifyAgentCredential(req.body));
    },
  );
}
