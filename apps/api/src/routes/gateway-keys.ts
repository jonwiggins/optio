import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { MODEL_GATEWAY_TYPES } from "@optio/shared";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  GatewayKeyError,
  adminRevokeKey,
  getKeyIssuing,
  issuePersonalKey,
  listIssuedKeys,
  myGatewayKeyStatus,
  revokePersonalKey,
  saveKeyIssuing,
} from "../services/gateway-keys.js";
import { providerViewer } from "./model-providers.js";

/**
 * Gateway keys made by Optio (docs/model-gateway.md "Keys Optio makes";
 * services/gateway-keys.ts). Registered by `modelGatewayRoutes`
 * (routes/model-gateway.ts).
 *
 * - The organization's gateway: which ways people get a token, the
 *   gateway's admin key (write-only), a new key's defaults, the keys Optio
 *   made and revoking one: workspace admins.
 * - A person's key: only that person gets, rotates or gives up their own.
 *   The key's value is never returned: it is stored as their gateway token.
 */

const providerParams = z.object({ id: z.string().uuid() });
const keyParams = z.object({ id: z.string().uuid(), keyId: z.string().uuid() });
const providerQuery = z.object({
  providerId: z
    .string()
    .uuid()
    .optional()
    .describe("The organization's gateway; absent = the workspace's default"),
});
const providerBody = z
  .object({ providerId: z.string().uuid().optional() })
  .describe("The organization's gateway; absent = the workspace's default")
  .nullish();

const amount = z.number().min(0).max(1_000_000_000).nullable();
const duration = z.string().max(16).nullable();

const ModesSchema = z.object({ personalPasted: z.boolean(), optioIssued: z.boolean() });

const GatewayTypeSchema = z.enum(MODEL_GATEWAY_TYPES as unknown as [string, ...string[]]);

const CapabilitiesSchema = z
  .object({
    catalog: z.boolean(),
    catalogDetails: z.boolean(),
    catalogAddsModels: z.boolean(),
    tokenBudget: z.boolean(),
    managedKeys: z.boolean(),
    budgets: z.boolean(),
    spend: z.boolean(),
    keyModels: z.boolean(),
  })
  .describe('What the gateway\'s type supports (docs/model-gateway.md, "Gateway types")');

const DefaultsSchema = z.object({
  maxBudget: amount,
  budgetDuration: duration,
  models: z.array(z.string()),
  keyDuration: duration,
});

const SettingsSchema = z.object({
  providerId: z.string(),
  gatewayType: GatewayTypeSchema,
  capabilities: CapabilitiesSchema,
  modes: ModesSchema,
  defaults: DefaultsSchema,
  hasAdminKey: z.boolean(),
  catalogModels: z.array(z.string()),
  staleModels: z
    .array(z.string())
    .describe("Picked models the catalog no longer serves: new keys leave them out"),
});

const SettingsBody = z.object({
  modes: ModesSchema.partial().optional(),
  adminKey: z
    .string()
    .max(4096)
    .nullable()
    .optional()
    .describe("A new admin key for the gateway; null clears it; absent keeps it. Never returned."),
  defaults: z
    .object({
      maxBudget: amount.optional(),
      budgetDuration: duration.optional(),
      models: z.array(z.string().max(200)).max(200).optional(),
      keyDuration: duration.optional(),
    })
    .strict()
    .optional(),
});

const IssuedKeySchema = z.object({
  id: z.string(),
  keyAlias: z.string().nullable(),
  keyHint: z.string().nullable(),
  models: z.array(z.string()),
  maxBudget: z.number().nullable(),
  budgetDuration: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  spendUsd: z.number().nullable(),
  budgetResetAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
});

const TestSchema = z.object({
  ok: z.boolean(),
  modelCount: z.number(),
  error: z.string().optional(),
});

const GatewayRefSchema = z.object({ id: z.string(), name: z.string(), type: GatewayTypeSchema });

const MyKeySchema = z.object({
  gateway: GatewayRefSchema.nullable(),
  modes: ModesSchema,
  canIssue: z.boolean(),
  issued: IssuedKeySchema.nullable(),
  defaults: z.object({
    maxBudget: z.number().nullable(),
    budgetDuration: z.string().nullable(),
    keyDuration: z.string().nullable(),
  }),
});

const IssueSchema = z.object({
  action: z.enum(["issue", "rotate"]),
  key: IssuedKeySchema,
  test: TestSchema,
});

const AdminKeySchema = IssuedKeySchema.extend({
  user: z
    .object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() })
    .nullable(),
});

const errors = {
  400: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  502: ErrorResponseSchema,
};

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof GatewayKeyError) return reply.status(err.status).send({ error: err.message });
  throw err;
}

export async function gatewayKeyRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const tags = ["Setup & Settings"];

  app.get(
    "/api/model-providers/:id/key-issuing",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "getGatewayKeyIssuing",
        summary: "How people get tokens for a gateway",
        description:
          "The organization's gateway: whether people paste their own tokens, whether Optio " +
          "makes keys on the gateway, whether its admin key is stored (never returned), what a " +
          "new key gets, and what the gateway's type supports. Admins only.",
        tags,
        params: providerParams,
        response: { 200: SettingsSchema, ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(await getKeyIssuing(req.params.id, providerViewer(req)));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put(
    "/api/model-providers/:id/key-issuing",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "saveGatewayKeyIssuing",
        summary: "Choose how people get tokens for a gateway",
        description:
          "Turn pasting and Optio-made keys on or off (at least one stays on; Optio-made keys " +
          "only on a gateway type with managed keys), store or clear the gateway's admin key " +
          "(tried against the gateway and kept either way) and set what a new key gets: budget, " +
          "budget period, models (where the gateway limits them) and life. Admins only.",
        tags,
        params: providerParams,
        body: SettingsBody,
        response: {
          200: z.object({
            settings: SettingsSchema,
            adminKeyTest: z.object({ ok: z.boolean(), error: z.string().optional() }).nullable(),
            changed: z.array(z.string()),
          }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(await saveKeyIssuing(req.params.id, req.body, providerViewer(req)));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/api/gateway/me/key",
    {
      schema: {
        operationId: "getMyGatewayKey",
        summary: "The viewer's ways to a gateway token, and the key Optio made them",
        description:
          "For an organization gateway (`providerId`, else the workspace's default): which ways it allows (paste, Optio-made), " +
          "whether Optio can make the viewer a key now, the key it made them (alias, last four " +
          "characters, budget, expiry; never the value) and the defaults a new key gets.",
        tags,
        querystring: providerQuery,
        response: { 200: MyKeySchema, ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(await myGatewayKeyStatus(providerViewer(req), req.query.providerId));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/api/gateway/me/key",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "issueMyGatewayKey",
        summary: "Get my gateway token (Optio makes it on the gateway)",
        description:
          "Makes a key on the gateway for the viewer (alias `optio-<user>`, the admin's budget, " +
          "expiry and, where the gateway limits them, models), stores it as their gateway token " +
          "and tries it. The value is never returned. With a key already made, it is replaced, " +
          "its spend this period carried over, and deleted on the gateway.",
        tags,
        body: providerBody,
        response: { 200: IssueSchema, ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(
          await issuePersonalKey(providerViewer(req), { providerId: req.body?.providerId }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/api/gateway/me/key/rotate",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "rotateMyGatewayKey",
        summary: "Rotate my Optio-made gateway key",
        description:
          "A new key replaces the one Optio made the viewer; the old one is deleted on the " +
          "gateway, and what it spent this budget period carries over to the new one. 404 when " +
          "Optio made them none.",
        tags,
        body: providerBody,
        response: { 200: IssueSchema, ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(
          await issuePersonalKey(providerViewer(req), {
            rotate: true,
            providerId: req.body?.providerId,
          }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/api/gateway/me/key",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "revokeMyGatewayKey",
        summary: "Give up my Optio-made gateway key",
        description:
          "Deletes the key on the gateway and removes it from the viewer's tokens. Their runs fail " +
          "with the missing-token message until they get or paste another.",
        tags,
        querystring: providerQuery,
        response: { 200: z.object({ revoked: z.number() }), ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(await revokePersonalKey(providerViewer(req), req.query.providerId));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/api/model-providers/:id/keys",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "listGatewayIssuedKeys",
        summary: "The keys Optio made on a gateway",
        description:
          "The active keys Optio made on the organization's gateway: whose, alias, last four " +
          "characters, budget, last spend read, expiry. Never a key's value. Admins only.",
        tags,
        params: providerParams,
        response: { 200: z.object({ keys: z.array(AdminKeySchema) }), ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send({ keys: await listIssuedKeys(req.params.id, providerViewer(req)) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/api/model-providers/:id/keys/:keyId",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "revokeGatewayIssuedKey",
        summary: "Revoke a key Optio made",
        description:
          "Blocks the key on the gateway (its spend kept there) and removes it from its owner's " +
          "tokens. Admins only.",
        tags,
        params: keyParams,
        response: { 200: z.object({ revoked: z.number() }), ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(
          await adminRevokeKey(req.params.id, req.params.keyId, providerViewer(req)),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
