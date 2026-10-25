import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import { auditEvent } from "../services/audit.js";
import { refuseUnlessDeploymentAdmin } from "../services/deployment-admin-gates.js";
import { publicApiOrigin } from "../services/oauth/provider.js";
import {
  ScimError,
  createScimGroup,
  createScimToken,
  createScimUser,
  deleteScimGroup,
  deleteScimUser,
  getScimGroup,
  getScimUser,
  listScimGroups,
  listScimUsers,
  patchScimGroup,
  patchScimUser,
  replaceScimGroup,
  replaceScimUser,
  revokeScimToken,
  saveScimSignInProvider,
  scimSettings,
  verifyScimToken,
} from "../services/scim.js";

/**
 * SCIM 2.0 provisioning (services/scim.ts, docs/directory-sync.md).
 *
 * The identity provider's side, under `/api/scim/v2` with a SCIM bearer
 * token (the session auth plugin lets the prefix through; every route here
 * checks the token): `ServiceProviderConfig`, `ResourceTypes`, `Schemas`,
 * and `Users` / `Groups` — list with an `eq` filter and paging, get, create,
 * replace, PATCH, delete. Bodies are `application/scim+json` (or JSON);
 * errors are SCIM error bodies. Hidden from the OpenAPI document: an
 * identity provider speaks SCIM, not Optio's API.
 *
 * The admin's side, deployment admins only (Settings → Access → Directory
 * sync → SCIM): `GET/PUT /api/admin/scim` (whether it is on, the SCIM base
 * URL, the sign-in provider that claims provisioned accounts) and
 * `POST /api/admin/scim/tokens`, `DELETE /api/admin/scim/tokens/:id`.
 */

const REFUSAL = "Only a deployment admin manages SCIM provisioning";
const SCIM_JSON = "application/scim+json";

function bearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

function sendScim(reply: FastifyReply, status: number, body: unknown) {
  return reply.status(status).type(SCIM_JSON).send(JSON.stringify(body));
}

function scimFailure(reply: FastifyReply, err: unknown) {
  if (err instanceof ScimError) return sendScim(reply, err.status, err.body());
  reply.log.error({ err }, "SCIM request failed");
  return sendScim(reply, 500, new ScimError(500, "Internal error").body());
}

const SERVICE_PROVIDER_CONFIG = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: "https://github.com/jonwiggins/optio/blob/main/docs/directory-sync.md",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "Bearer token",
      description: "A SCIM token a deployment admin generated in Optio",
      primary: true,
    },
  ],
};

const RESOURCE_TYPES = [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User",
    name: "User",
    endpoint: "/Users",
    schema: "urn:ietf:params:scim:schemas:core:2.0:User",
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
  },
];

const SCHEMAS = [
  {
    id: "urn:ietf:params:scim:schemas:core:2.0:User",
    name: "User",
    attributes: ["userName", "externalId", "name", "displayName", "emails", "active", "groups"].map(
      (name) => ({ name }),
    ),
  },
  {
    id: "urn:ietf:params:scim:schemas:core:2.0:Group",
    name: "Group",
    attributes: ["displayName", "externalId", "members"].map((name) => ({ name })),
  },
];

const idParams = z.object({ id: z.string() });
const listQuery = z
  .object({
    filter: z.string().max(1000).optional(),
    startIndex: z.string().optional(),
    count: z.string().optional(),
    excludedAttributes: z.string().max(200).optional(),
    attributes: z.string().max(500).optional(),
  })
  .passthrough();
const anyBody = z.record(z.string(), z.unknown());

/** The identity provider's SCIM endpoints. */
async function scimProtocolRoutes(rawApp: FastifyInstance, opts: { basePath: string }) {
  const baseUrl = () => `${publicApiOrigin()}${opts.basePath}`;
  // SCIM bodies are JSON under their own media type.
  rawApp.addContentTypeParser(
    /^application\/scim\+json/,
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );
  rawApp.addHook("preHandler", async (req, reply) => {
    if (!(await verifyScimToken(bearer(req)))) {
      return sendScim(
        reply,
        401,
        new ScimError(401, "A valid SCIM bearer token is required").body(),
      );
    }
  });
  // A body the schema refuses still answers as SCIM.
  rawApp.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 400 && status < 500) {
      const message = err instanceof Error && err.message ? err.message : "Invalid request";
      return sendScim(reply, 400, new ScimError(400, message, "invalidSyntax").body());
    }
    return scimFailure(reply, err);
  });

  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const hidden = { hide: true, tags: ["Auth & Sessions"], security: [] };

  app.get(`${opts.basePath}/ServiceProviderConfig`, { schema: hidden }, async (_req, reply) =>
    sendScim(reply, 200, SERVICE_PROVIDER_CONFIG),
  );
  app.get(`${opts.basePath}/ResourceTypes`, { schema: hidden }, async (_req, reply) =>
    sendScim(reply, 200, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: RESOURCE_TYPES.length,
      Resources: RESOURCE_TYPES,
    }),
  );
  app.get(`${opts.basePath}/Schemas`, { schema: hidden }, async (_req, reply) =>
    sendScim(reply, 200, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: SCHEMAS.length,
      Resources: SCHEMAS,
    }),
  );

  // ── Users ──
  app.get(
    `${opts.basePath}/Users`,
    { schema: { ...hidden, querystring: listQuery } },
    async (req, reply) => {
      try {
        return sendScim(reply, 200, await listScimUsers(req.query, baseUrl()));
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
  app.get(
    `${opts.basePath}/Users/:id`,
    { schema: { ...hidden, params: idParams } },
    async (req, reply) => {
      try {
        return sendScim(reply, 200, await getScimUser(req.params.id, baseUrl()));
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
  app.post(
    `${opts.basePath}/Users`,
    { schema: { ...hidden, body: anyBody } },
    async (req, reply) => {
      try {
        const user = await createScimUser(req.body, baseUrl());
        void audit(req, "scim.user_provisioned", { targetUserId: user.id });
        return sendScim(reply, 201, user);
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
  app.put(
    `${opts.basePath}/Users/:id`,
    { schema: { ...hidden, params: idParams, body: anyBody } },
    async (req, reply) => {
      try {
        return sendScim(reply, 200, await replaceScimUser(req.params.id, req.body, baseUrl()));
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
  app.patch(
    `${opts.basePath}/Users/:id`,
    { schema: { ...hidden, params: idParams, body: anyBody } },
    async (req, reply) => {
      try {
        return sendScim(reply, 200, await patchScimUser(req.params.id, req.body, baseUrl()));
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
  app.delete(
    `${opts.basePath}/Users/:id`,
    { schema: { ...hidden, params: idParams } },
    async (req, reply) => {
      try {
        await deleteScimUser(req.params.id);
        void audit(req, "scim.user_deprovisioned", { targetUserId: req.params.id });
        return reply.status(204).send();
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );

  // ── Groups ──
  app.get(
    `${opts.basePath}/Groups`,
    { schema: { ...hidden, querystring: listQuery } },
    async (req, reply) => {
      try {
        return sendScim(reply, 200, await listScimGroups(req.query, baseUrl()));
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
  app.get(
    `${opts.basePath}/Groups/:id`,
    { schema: { ...hidden, params: idParams, querystring: listQuery } },
    async (req, reply) => {
      try {
        return sendScim(
          reply,
          200,
          await getScimGroup(req.params.id, baseUrl(), req.query.excludedAttributes),
        );
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
  app.post(
    `${opts.basePath}/Groups`,
    { schema: { ...hidden, body: anyBody } },
    async (req, reply) => {
      try {
        return sendScim(reply, 201, await createScimGroup(req.body, baseUrl()));
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
  app.put(
    `${opts.basePath}/Groups/:id`,
    { schema: { ...hidden, params: idParams, body: anyBody } },
    async (req, reply) => {
      try {
        return sendScim(reply, 200, await replaceScimGroup(req.params.id, req.body, baseUrl()));
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
  app.patch(
    `${opts.basePath}/Groups/:id`,
    { schema: { ...hidden, params: idParams, body: anyBody } },
    async (req, reply) => {
      try {
        return sendScim(reply, 200, await patchScimGroup(req.params.id, req.body, baseUrl()));
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
  app.delete(
    `${opts.basePath}/Groups/:id`,
    { schema: { ...hidden, params: idParams } },
    async (req, reply) => {
      try {
        await deleteScimGroup(req.params.id);
        return reply.status(204).send();
      } catch (err) {
        return scimFailure(reply, err);
      }
    },
  );
}

function audit(req: FastifyRequest, action: string, details: Record<string, unknown>) {
  return auditEvent({
    req,
    action,
    userId: req.user?.id ?? null,
    workspaceId: null,
    details,
  }).catch(() => {});
}

const ScimTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

const ScimSettingsSchema = z.object({
  enabled: z.boolean(),
  signInProvider: z.string().nullable(),
  tokens: z.array(ScimTokenSchema),
  baseUrl: z.string(),
});

export async function scimRoutes(rawApp: FastifyInstance) {
  await rawApp.register(scimProtocolRoutes, { basePath: "/api/scim/v2" });
  await rawApp.register(scimProtocolRoutes, { basePath: "/scim/v2" });
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/admin/scim",
    {
      schema: {
        operationId: "getScimSettings",
        summary: "SCIM provisioning: whether it is on, its base URL, tokens",
        description: "Deployment admins only. Tokens are listed by name and prefix, never whole.",
        tags: ["Setup & Settings"],
        response: { 200: ScimSettingsSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, REFUSAL)) return;
      reply.send(await scimSettings(publicApiOrigin()));
    },
  );

  app.put(
    "/api/admin/scim",
    {
      schema: {
        operationId: "saveScimSettings",
        summary: "SCIM provisioning: the sign-in provider that claims provisioned accounts",
        tags: ["Setup & Settings"],
        body: z.object({
          signInProvider: z
            .string()
            .nullable()
            .describe("The sign-in provider people provisioned here sign in with; null: none"),
        }),
        response: { 200: ScimSettingsSchema, 400: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, REFUSAL)) return;
      try {
        await saveScimSignInProvider(req.body.signInProvider, req.user?.id ?? null);
      } catch (err) {
        if (err instanceof ScimError) return reply.status(400).send({ error: err.message });
        throw err;
      }
      void audit(req, "scim.settings_saved", { signInProvider: req.body.signInProvider });
      reply.send(await scimSettings(publicApiOrigin()));
    },
  );

  app.post(
    "/api/admin/scim/tokens",
    {
      schema: {
        operationId: "createScimToken",
        summary: "Generate a SCIM bearer token (shown once)",
        tags: ["Setup & Settings"],
        body: z.object({ name: z.string().trim().max(100).default("SCIM") }),
        response: {
          201: z.object({ token: z.string(), view: ScimTokenSchema }),
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, REFUSAL)) return;
      const created = await createScimToken(req.body.name, req.user?.id ?? null);
      void audit(req, "scim.token_created", { id: created.view.id, name: created.view.name });
      reply.status(201).send(created);
    },
  );

  app.delete(
    "/api/admin/scim/tokens/:id",
    {
      schema: {
        operationId: "revokeScimToken",
        summary: "Revoke a SCIM token",
        tags: ["Setup & Settings"],
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, REFUSAL)) return;
      if (!(await revokeScimToken(req.params.id))) {
        return reply.status(404).send({ error: "No such token" });
      }
      void audit(req, "scim.token_revoked", { id: req.params.id });
      reply.status(204).send(null);
    },
  );
}
