import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  REMOTE_WORKSPACE_PROVIDERS,
  REMOTE_WORKSPACE_PROVIDER_INFO,
  type RemoteWorkspaceProviderId,
} from "@optio/shared";
import { db } from "../db/client.js";
import { localHosts } from "../db/schema.js";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema, ResourceOwnerSchema } from "../schemas/common.js";
import { isSsrfSafeUrl } from "../utils/ssrf.js";
import { actorOf } from "../services/ownership.js";
import { auditEvent, ownerDetails } from "../services/audit.js";
import {
  RemoteWorkspaceError,
  clientFor,
  createConnection,
  deleteConnection,
  getVisibleConnection,
  listConnections,
  mayChangeConnection,
  releaseWorkspacePairings,
  testConnection,
  updateConnection,
} from "../services/remote-workspace-service.js";
import type { RemoteWorkspace } from "../services/remote-workspaces/types.js";

/**
 * Remote workspaces (docs/remote-workspaces.md): the connections Settings →
 * Integrations → Remote workspaces manages, and what the New work form's
 * remote-workspace location picks from — templates (snapshots,
 * repositories), their parameters, and the token's workspaces. Whose a
 * connection is follows services/ownership.ts: the organization's (a
 * workspace admin adds it), a team's (its team admins), a person's.
 *
 * Every route is under /api/remote-workspaces. The /api/coder/connections
 * routes from when Coder was the only provider answer the same (a list of
 * the Coder connections, a new one is Coder's); they are left out of the
 * OpenAPI document.
 */

const ProviderSchema = z.enum(REMOTE_WORKSPACE_PROVIDERS);

const urlField = z
  .string()
  .url()
  .max(500)
  .refine(isSsrfSafeUrl, {
    message:
      "The outbound policy doesn't allow this host — list it in OPTIO_OUTBOUND_ALLOWED_HOSTS",
  })
  .describe("The provider's API, e.g. https://coder.example.com");

const parametersField = z
  .record(z.string().max(4000))
  .refine((p) => Object.keys(p).length <= 100, { message: "At most 100 parameters" })
  .describe("Parameter values every new workspace gets (the work's own override them)");

const editable = {
  caPem: z.string().max(20000).nullable().optional().describe("PEM bundle of a private CA"),
  insecureSkipVerify: z.boolean().optional().describe("Skip TLS verification (testing only)"),
  organizationId: z.string().max(100).nullable().optional(),
  templateId: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("The default template (snapshot, repository)"),
  templateVersionId: z.string().max(200).nullable().optional(),
  templateName: z.string().max(200).nullable().optional(),
  defaultParameters: parametersField.optional(),
  ttlMs: z
    .number()
    .int()
    .min(60_000)
    .max(30 * 24 * 60 * 60_000)
    .nullable()
    .optional()
    .describe("How long a workspace may run (each provider's meaning; docs/remote-workspaces.md)"),
  deleteWhenDone: z
    .boolean()
    .optional()
    .describe("Delete the workspace when the work ends (default: stop it)"),
  enabled: z.boolean().optional(),
};

const createFields = {
  name: z.string().min(1).max(100),
  token: z.string().min(1).max(2000).describe("The provider's token or API key (write-only)"),
  owner: ResourceOwnerSchema.optional().describe(
    'Whose it is: "workspace" (the organization\'s; default), "me", or "team:<id>"',
  ),
  ...editable,
};

const createSchema = z
  .object({
    provider: ProviderSchema,
    // Blank: the provider's own API (api.github.com, …); Coder's must be given.
    url: z.union([urlField, z.literal("")]).optional(),
    ...createFields,
  })
  .describe("Body for adding a remote-workspace connection");

/** The older Coder-only body: no provider, a URL. */
const coderCreateSchema = z
  .object({ url: urlField, ...createFields })
  .describe("Body for adding a Coder connection");

const updateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    url: z.union([urlField, z.literal("")]).optional(),
    token: z.string().min(1).max(2000).optional().describe("A new token; absent keeps it"),
    ...editable,
  })
  .describe("Body for changing a remote-workspace connection (absent fields are kept)");

const ConnectionSchema = z
  .object({
    id: z.string(),
    provider: ProviderSchema,
    workspaceId: z.string().nullable(),
    ownerUserId: z.string().nullable(),
    ownerTeamId: z.string().nullable(),
    ownerName: z.string().nullable().optional(),
    ownerTeamName: z.string().nullable().optional(),
    name: z.string(),
    url: z.string().describe("The API it reaches; blank = the provider's own"),
    hasToken: z.boolean(),
    tokenHint: z.string().nullable().describe("The token's last four characters"),
    caPem: z.string().nullable(),
    insecureSkipVerify: z.boolean(),
    organizationId: z.string().nullable(),
    templateId: z.string().nullable(),
    templateVersionId: z.string().nullable(),
    templateName: z.string().nullable(),
    defaultParameters: z.record(z.string()),
    ttlMs: z.number().nullable(),
    deleteWhenDone: z.boolean(),
    lastTestedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    enabled: z.boolean(),
    canEdit: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .describe("A remote-workspace connection (its token is never returned)");

const idParams = z.object({ id: z.string().uuid() });

const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  organizationId: z.string().nullable(),
  activeVersionId: z.string(),
});

const ParameterSchema = z.object({
  name: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  type: z.string(),
  mutable: z.boolean(),
  required: z.boolean(),
  defaultValue: z.string().nullable(),
  ephemeral: z.boolean(),
  options: z.array(
    z.object({ name: z.string(), value: z.string(), description: z.string().nullable() }),
  ),
  /** Optio fills it (the pairing bundle, the checkout). */
  setByOptio: z.boolean(),
});

const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerName: z.string().nullable(),
  templateId: z.string().nullable(),
  templateName: z.string().nullable(),
  status: z
    .string()
    .describe("running, stopped, starting, stopping, failed, deleted (Coder: its build's status)"),
  transition: z.string(),
});

const ProviderInfoSchema = z.object({
  id: ProviderSchema,
  label: z.string(),
  defaultUrl: z.string().nullable(),
  templateNoun: z.string(),
  workspaceNoun: z.string(),
  defaultCheckoutDir: z.string(),
  stopVerb: z.enum(["stop", "pause"]),
  personalOnly: z.boolean(),
});

function workspaceView(ws: RemoteWorkspace) {
  return {
    id: ws.id,
    name: ws.name,
    ownerName: ws.ownerName,
    templateId: ws.templateId,
    templateName: ws.templateName,
    status: ws.status,
    transition: ws.transition,
  };
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof RemoteWorkspaceError) {
    return reply.status(err.status).send({ error: err.message });
  }
  throw err;
}

const TAGS = ["Repos & Integrations"];

export async function remoteWorkspaceRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const member = [requireRole("member")];

  /** The connection when the caller sees it; otherwise the 404 is sent. */
  const visible = async (id: string, req: Parameters<typeof actorOf>[0], reply: FastifyReply) => {
    const row = await getVisibleConnection(id, actorOf(req));
    if (!row) {
      reply.status(404).send({ error: "Connection not found" });
      return null;
    }
    return row;
  };

  app.get(
    "/api/remote-workspaces/providers",
    {
      schema: {
        operationId: "listRemoteWorkspaceProviders",
        summary: "List the remote-workspace providers",
        description: "What each provider calls its parts, and its defaults.",
        tags: TAGS,
        response: { 200: z.object({ providers: z.array(ProviderInfoSchema) }) },
      },
    },
    async (_req, reply) => {
      reply.send({
        providers: REMOTE_WORKSPACE_PROVIDERS.map((id) => {
          const p = REMOTE_WORKSPACE_PROVIDER_INFO[id];
          return {
            id,
            label: p.label,
            defaultUrl: p.defaultUrl,
            templateNoun: p.templateNoun,
            workspaceNoun: p.workspaceNoun,
            defaultCheckoutDir: p.defaultCheckoutDir,
            stopVerb: p.stopVerb,
            personalOnly: p.personalOnly,
          };
        }),
      });
    },
  );

  // Each route below is registered under /api/remote-workspaces/connections
  // and again under the older /api/coder/connections (hidden from the docs).
  const routes = (base: string, older: boolean) => {
    const hide = older ? { hide: true } : {};
    const op = (current: string, previous: string) => (older ? previous : current);
    const coderOnly: RemoteWorkspaceProviderId | undefined = older ? "coder" : undefined;

    app.get(
      base,
      {
        schema: {
          ...hide,
          operationId: op("listRemoteWorkspaceConnections", "listCoderConnections"),
          summary: "List remote-workspace connections",
          description:
            "The organization's connections, the caller's teams' and the caller's own " +
            "(optionally of one `provider`). Tokens are never returned (`tokenHint` is the " +
            "last four characters).",
          tags: TAGS,
          querystring: z.object({ provider: ProviderSchema.optional() }),
          response: { 200: z.object({ connections: z.array(ConnectionSchema) }) },
        },
      },
      async (req, reply) => {
        reply.send({
          connections: await listConnections(actorOf(req), {
            provider: coderOnly ?? req.query.provider,
          }),
        });
      },
    );

    app.post(
      base,
      {
        preHandler: member,
        schema: {
          ...hide,
          operationId: op("createRemoteWorkspaceConnection", "createCoderConnection"),
          summary: "Add a remote-workspace connection",
          description:
            "One per provider per scope: the organization's (a workspace admin), a team's " +
            "(`team:<id>`, its team admins) or the caller's own (`me`, with their own token). " +
            "A GitHub Codespaces connection is a person's own. The token is sealed on the row.",
          tags: TAGS,
          body: older ? coderCreateSchema : createSchema,
          response: {
            201: z.object({ connection: ConnectionSchema }),
            400: ErrorResponseSchema,
            403: ErrorResponseSchema,
            409: ErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        const body = req.body;
        // The older routes' body names no provider: those are Coder's.
        const provider = coderOnly ?? ("provider" in body ? body.provider : null);
        if (!provider) return reply.status(400).send({ error: "Which provider?" });
        const url = body.url?.trim() || REMOTE_WORKSPACE_PROVIDER_INFO[provider].defaultUrl;
        if (!url) {
          return reply.status(400).send({
            error: `A ${REMOTE_WORKSPACE_PROVIDER_INFO[provider].label} connection needs its URL`,
          });
        }
        try {
          const connection = await createConnection(
            { ...body, provider, url: body.url?.trim() ?? "" },
            actorOf(req),
          );
          // The audit trail (docs/audit.md): never the token.
          void auditEvent({
            req,
            action: "remote_workspace_connection.create",
            details: {
              id: connection.id,
              provider: connection.provider,
              name: connection.name,
              ...ownerDetails(req, connection),
            },
          });
          return reply.status(201).send({ connection });
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.patch(
      `${base}/:id`,
      {
        preHandler: member,
        schema: {
          ...hide,
          operationId: op("updateRemoteWorkspaceConnection", "updateCoderConnection"),
          summary: "Change a remote-workspace connection",
          tags: TAGS,
          params: idParams,
          body: updateSchema,
          response: {
            200: z.object({ connection: ConnectionSchema }),
            400: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        try {
          const connection = await updateConnection(req.params.id, req.body, actorOf(req));
          void auditEvent({
            req,
            action: "remote_workspace_connection.update",
            details: {
              id: connection.id,
              provider: connection.provider,
              name: connection.name,
              ...ownerDetails(req, connection),
              // Which fields the save sent (names only: a new token is "token").
              fields: Object.keys(req.body).sort(),
            },
          });
          return reply.send({ connection });
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.delete(
      `${base}/:id`,
      {
        preHandler: member,
        schema: {
          ...hide,
          operationId: op("deleteRemoteWorkspaceConnection", "deleteCoderConnection"),
          summary: "Remove a remote-workspace connection",
          description: "Workspaces it started keep running until their TTL stops them.",
          tags: TAGS,
          params: idParams,
          response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
        },
      },
      async (req, reply) => {
        try {
          const removed = await deleteConnection(req.params.id, actorOf(req));
          void auditEvent({
            req,
            action: "remote_workspace_connection.delete",
            details: {
              id: req.params.id,
              provider: removed?.provider,
              name: removed?.name,
              ...ownerDetails(req, removed ?? {}),
            },
          });
          return reply.status(204).send(null);
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.post(
      `${base}/:id/test`,
      {
        preHandler: member,
        schema: {
          ...hide,
          operationId: op("testRemoteWorkspaceConnection", "testCoderConnection"),
          summary: "Test a remote-workspace connection",
          description:
            "Signs in to the provider with the stored token. A failed test is a 200 with " +
            "`ok: false` and the reason. `user.username` is empty when the provider doesn't " +
            "say whose the token is (E2B).",
          tags: TAGS,
          params: idParams,
          response: {
            200: z.object({
              ok: z.boolean(),
              user: z.object({ username: z.string(), email: z.string().optional() }).optional(),
              error: z.string().optional(),
            }),
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        try {
          return reply.send(await testConnection(req.params.id, actorOf(req)));
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.get(
      `${base}/:id/templates`,
      {
        schema: {
          ...hide,
          operationId: op("listRemoteWorkspaceTemplates", "listCoderTemplates"),
          summary: "List a connection's templates",
          description:
            "What a new workspace is made from: Coder templates (of `organizationId`, default " +
            "the connection's, else the token user's default organization), Daytona " +
            "snapshots, E2B templates, or GitHub repositories (of `organizationId`, default " +
            "the token's own).",
          tags: TAGS,
          params: idParams,
          querystring: z.object({ organizationId: z.string().max(100).optional() }),
          response: {
            200: z.object({ organizationId: z.string(), templates: z.array(TemplateSchema) }),
            404: ErrorResponseSchema,
            502: ErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        const row = await visible(req.params.id, req, reply);
        if (!row) return;
        try {
          return reply.send(
            await clientFor(row).templates(req.query.organizationId || row.organizationId),
          );
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.get(
      `${base}/:id/templates/:versionId/parameters`,
      {
        schema: {
          ...hide,
          operationId: op("listRemoteWorkspaceTemplateParameters", "listCoderTemplateParameters"),
          summary: "A template's parameters",
          description:
            "Its parameters, to render a form (a Coder template version's rich parameters; " +
            "a repository's machine types and dev containers). `setByOptio` marks the ones " +
            "Optio fills (the pairing bundle, the checkout).",
          tags: TAGS,
          params: z.object({ id: z.string().uuid(), versionId: z.string().min(1).max(200) }),
          response: {
            200: z.object({ parameters: z.array(ParameterSchema) }),
            404: ErrorResponseSchema,
            502: ErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        const row = await visible(req.params.id, req, reply);
        if (!row) return;
        try {
          return reply.send({ parameters: await clientFor(row).parameters(req.params.versionId) });
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.get(
      `${base}/:id/workspaces`,
      {
        schema: {
          ...hide,
          operationId: op("listRemoteWorkspaces", "listCoderWorkspaces"),
          summary: "List the connection's workspaces",
          description: 'The token\'s workspaces — for "an existing workspace".',
          tags: TAGS,
          params: idParams,
          response: {
            200: z.object({ workspaces: z.array(WorkspaceSchema) }),
            404: ErrorResponseSchema,
            502: ErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        const row = await visible(req.params.id, req, reply);
        if (!row) return;
        try {
          const workspaces = await clientFor(row).workspaces();
          return reply.send({ workspaces: workspaces.map(workspaceView) });
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );

    app.post(
      `${base}/:id/workspaces/:wsId/stop`,
      {
        preHandler: member,
        schema: {
          ...hide,
          operationId: op("stopRemoteWorkspace", "stopCoderWorkspace"),
          summary: "Stop a remote workspace",
          description:
            "Those who may change the connection stop any of its workspaces; anyone else only " +
            "a workspace Optio started for their own work. (E2B pauses it.)",
          tags: TAGS,
          params: z.object({ id: z.string().uuid(), wsId: z.string().min(1).max(200) }),
          response: {
            200: z.object({ ok: z.literal(true), status: z.string() }),
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            502: ErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        const row = await visible(req.params.id, req, reply);
        if (!row) return;
        const actor = actorOf(req);
        if (!mayChangeConnection(row, actor)) {
          const [mine] = actor.userId
            ? await db
                .select({ id: localHosts.id })
                .from(localHosts)
                .where(
                  and(
                    eq(localHosts.userId, actor.userId),
                    eq(localHosts.remoteWorkspaceId, req.params.wsId),
                  ),
                )
            : [];
          if (!mine) {
            return reply.status(403).send({ error: "Only a workspace Optio started for you" });
          }
        }
        try {
          const status = await clientFor(row).stop(req.params.wsId);
          // Its pairing tokens go with it (docs/remote-workspaces.md).
          await releaseWorkspacePairings(row.id, req.params.wsId);
          return reply.send({ ok: true as const, status });
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );
  };

  routes("/api/remote-workspaces/connections", false);
  routes("/api/coder/connections", true);
}
