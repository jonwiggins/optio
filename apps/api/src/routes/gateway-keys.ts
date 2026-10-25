import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { MODEL_GATEWAY_TYPES } from "@optio/shared";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  GatewayKeyError,
  createTeamKey,
  getKeyIssuing,
  issuePersonalKey,
  myGatewayKeyStatus,
  revokePersonalKey,
  revokeTeamKey,
  saveKeyIssuing,
  setTeamBudget,
  teamGatewayKeyStatus,
} from "../services/gateway-keys.js";
import { actorOf } from "../services/ownership.js";
import { teamUsage } from "../services/team-usage-service.js";

/**
 * Gateway keys made by Optio, and team budgets (docs/model-gateway.md "Keys
 * Optio makes"; services/gateway-keys.ts). Registered by
 * `modelGatewayRoutes` (routes/model-gateway.ts).
 *
 * - The organization's gateway: which ways people get a token, the
 *   gateway's admin key, a new key's defaults — workspace admins.
 * - A person's key: only that person gets, rotates or gives up their own.
 * - A team's key and budget: its team admins and workspace admins change
 *   them; its members read them.
 * - Usage per team: a workspace admin's every team, anyone else's own.
 */

const providerParams = z.object({ id: z.string().uuid() });
const teamParams = z.object({ teamId: z.string().uuid() });

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
  teamMaxBudget: amount,
  teamBudgetDuration: duration,
  workspace: z.string().nullable().optional().describe("Portkey: the workspace keys are made in"),
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
      teamMaxBudget: amount.optional(),
      teamBudgetDuration: duration.optional(),
      workspace: z.string().max(200).nullable().optional(),
    })
    .optional(),
});

const IssuedKeySchema = z.object({
  id: z.string(),
  kind: z.enum(["person", "team"]),
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

const BudgetSchema = z.object({
  spend: z.number().nullable(),
  maxBudget: z.number().nullable(),
  budgetDuration: z.string().nullable(),
  budgetResetAt: z.string().nullable(),
  source: z.enum(["gateway", "saved"]),
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
  secretName: z.string(),
  test: TestSchema,
});

const TeamStatusSchema = z.object({
  team: z.object({ id: z.string(), name: z.string() }),
  gateway: GatewayRefSchema.nullable(),
  modes: ModesSchema,
  canIssue: z.boolean(),
  canManage: z.boolean(),
  hasToken: z.boolean(),
  issued: IssuedKeySchema.nullable(),
  budget: BudgetSchema.nullable(),
  defaults: z.object({ maxBudget: z.number().nullable(), budgetDuration: z.string().nullable() }),
  budgetCap: z.number().nullable(),
});

const TeamBudgetBody = z.object({
  maxBudget: amount.optional().describe("USD per period; null = no cap"),
  budgetDuration: duration
    .optional()
    .describe('A duration, like "30d" or "1mo" (the nearest period the gateway takes)'),
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
        return reply.send(await getKeyIssuing(req.params.id, actorOf(req)));
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
          "budget period, models (where the gateway limits them), life, and a team's budget and " +
          "the most a team admin may set. Admins only.",
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
        return reply.send(await saveKeyIssuing(req.params.id, req.body, actorOf(req), { req }));
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
          "For the workspace's default gateway: which ways it allows (paste, Optio-made), " +
          "whether Optio can make the viewer a key now, the key it made them (alias, last four " +
          "characters, budget, expiry; never the value) and the defaults a new key gets.",
        tags,
        response: { 200: MyKeySchema },
      },
    },
    async (req, reply) => reply.send(await myGatewayKeyStatus(actorOf(req))),
  );

  app.post(
    "/api/gateway/me/key",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "issueMyGatewayKey",
        summary: "Get my gateway token (Optio makes it on the gateway)",
        description:
          "Makes a key on the gateway for the viewer (alias `optio-<user>`, the gateway's " +
          "budget, expiry and, where it limits them, models), stores it as their gateway token " +
          "and tries it. With a key already made, it is replaced and deleted on the gateway.",
        tags,
        body: z.object({}).optional(),
        response: { 200: IssueSchema, ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(await issuePersonalKey(actorOf(req), {}, { req }));
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
          "gateway (Portkey gives the same key a new value). 404 when Optio made them none.",
        tags,
        body: z.object({}).optional(),
        response: { 200: IssueSchema, ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(await issuePersonalKey(actorOf(req), { rotate: true }, { req }));
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
        response: { 200: z.object({ revoked: z.number() }), ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(await revokePersonalKey(actorOf(req), { req }));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/api/gateway/teams/:teamId",
    {
      schema: {
        operationId: "getTeamGatewayKey",
        summary: "A team's gateway token, Optio-made key and budget",
        description:
          "Whether the team has a gateway token, the key Optio made it (never the value), its " +
          "budget and spend on the gateway, and what its admins may change. The team's members, its " +
          "admins and workspace admins; 404 for anyone else.",
        tags,
        params: teamParams,
        response: { 200: TeamStatusSchema, ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(await teamGatewayKeyStatus(req.params.teamId, actorOf(req)));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/api/gateway/teams/:teamId/key",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createTeamGatewayKey",
        summary: "Create (or rotate) a team's gateway key",
        description:
          "On LiteLLM a LiteLLM team with the budget (`/team/new`, made once) and a key bound " +
          "to it; elsewhere one key whose own limit is the budget. Stored as the team's gateway " +
          "token. With a key already made, it is replaced and the " +
          "old one deleted. The team's admins and workspace admins; a team admin's budget is " +
          "capped by the gateway's team budget.",
        tags,
        params: teamParams,
        body: TeamBudgetBody.optional(),
        response: {
          200: IssueSchema.extend({ budget: BudgetSchema }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(
          await createTeamKey(req.params.teamId, actorOf(req), req.body ?? {}, { req }),
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put(
    "/api/gateway/teams/:teamId/budget",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "setTeamGatewayBudget",
        summary: "Set a team's gateway budget",
        description:
          "The team's budget on the gateway (LiteLLM: its team's `max_budget` and " +
          "`budget_duration`; elsewhere its key's limit); the gateway " +
          "refuses the team's runs once it is spent. The team's admins and workspace admins.",
        tags,
        params: teamParams,
        body: TeamBudgetBody,
        response: { 200: z.object({ budget: BudgetSchema }), ...errors },
      },
    },
    async (req, reply) => {
      try {
        const budget = await setTeamBudget(req.params.teamId, actorOf(req), req.body, { req });
        return reply.send({ budget });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete(
    "/api/gateway/teams/:teamId/key",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "revokeTeamGatewayKey",
        summary: "Revoke a team's Optio-made gateway key",
        description:
          "Deletes the key on the gateway and removes the team's token (on LiteLLM the LiteLLM " +
          "team and its spend stay). The team's admins and workspace admins.",
        tags,
        params: teamParams,
        response: { 200: z.object({ revoked: z.number() }), ...errors },
      },
    },
    async (req, reply) => {
      try {
        return reply.send(await revokeTeamKey(req.params.teamId, actorOf(req), { req }));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/api/usage/teams",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "getTeamUsage",
        summary: "Usage per team",
        description:
          "Tokens, cost and runs of each team's work over the last `days` days (team-owned " +
          "work charged to its team, whoever started it), with the team's gateway budget when " +
          "Optio made its key. Workspace admins see every team, others their own.",
        tags: ["Analytics"],
        querystring: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }),
        response: {
          200: z.object({
            start: z.string(),
            end: z.string(),
            teams: z.array(
              z.object({
                teamId: z.string(),
                name: z.string(),
                tokens: z.number(),
                costUsd: z.string().nullable(),
                runs: z.number(),
                gatewayBudget: BudgetSchema.nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (req, reply) => reply.send(await teamUsage(actorOf(req), req.query.days ?? 30)),
  );
}
