import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { captureRawBody, rawBodyOf } from "../utils/webhook-signature.js";
import { db } from "../db/client.js";
import { ticketProviders, authEvents } from "../db/schema.js";
import { TaskState, type TicketSource } from "@optio/shared";
import { getTicketProvider, jiraConfigProblem } from "@optio/ticket-providers";
import * as taskService from "../services/task-service.js";
import { syncAllTickets, resolveProviderConfig } from "../services/ticket-sync-service.js";
import { storeSecret, deleteSecret } from "../services/secret-service.js";
import { RECENT_AUTH_FAILURE_WINDOW_MS } from "../services/auth-failure-detector.js";
import { isSsrfSafeUrl, isSsrfSafeHost } from "../utils/ssrf.js";
import { HmacSha256Verifier } from "../services/crypto/signer.js";
import { logger } from "../logger.js";
import { claimDelivery } from "./event-ingress.js";
import { ErrorResponseSchema, IdParamsSchema, WorkOwnerSchema } from "../schemas/common.js";
import { TicketProviderSchema } from "../schemas/integration.js";
import { requireDeploymentAdmin, requireRole } from "../plugins/auth.js";
import { receiverFor, ticketSourceRefusal } from "../services/feature-guard.js";
import {
  OwnerError,
  actorOf,
  canChange,
  changeRefusal,
  ownerColumnsForNew,
  visibleOwner,
  withOwnerNames,
  type Actor,
} from "../services/ownership.js";

/**
 * Whose a ticket provider is (services/ownership.ts): the workspace's
 * (`workspace`, the default; a workspace admin adds it), one of the caller's
 * teams' (`team:<id>`, its team admins; teams on) or the caller's own (`me`).
 * The tasks its tickets become are its owner's (ticket-sync-service.ts), on
 * the workspace's repositories only. The deployment's (no workspace: every
 * provider from before owners, and a deployment admin's organization one)
 * syncs any repository, as before, and only a deployment admin changes it.
 */
const providerOwnerField = WorkOwnerSchema.optional().describe(
  'Whose it is: "workspace" (the workspace\'s; default), "me", or "team:<id>"',
);

// ── Zod schemas for ticket provider config ─────────────────────────────────

// Jira Cloud needs baseUrl + email + apiToken; a self-hosted Server / Data
// Center needs baseUrl + apiToken (a personal access token) or, with basic
// auth, baseUrl + username + apiToken (the password). `jiraConfigProblem`
// is the provider's own rule, so the two cannot drift.
const jiraConfigSchema = z.object({
  source: z.literal("jira"),
  config: z
    .object({
      baseUrl: z.string().url().refine(isSsrfSafeUrl, {
        message: "URL must not target private or internal addresses",
      }),
      deployment: z
        .enum(["cloud", "server"])
        .optional()
        .describe("Jira Cloud (default with an email) or a self-hosted Server / Data Center"),
      authType: z
        .enum(["basic", "pat"])
        .optional()
        .describe("basic: email or username + apiToken; pat: a Server personal access token"),
      email: z.string().email().optional(),
      username: z.string().min(1).optional(),
      apiToken: z.string().min(1),
      caPem: z
        .string()
        .max(20000)
        .nullable()
        .optional()
        .describe("PEM bundle of the CA behind a Server's certificate"),
      jql: z.string().max(2000).nullable().optional().describe("Extra JQL ANDed into the search"),
      projectKey: z.string().optional(),
      label: z.string().optional(),
      maxPages: z.number().int().positive().optional(),
      doneStatusName: z.string().optional(),
      todoStatusName: z.string().optional(),
      repoUrl: z.string().url().optional(),
    })
    .superRefine((config, ctx) => {
      const problem = jiraConfigProblem(config);
      if (problem) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [problem.field],
          message: problem.message,
        });
      }
      if (config.caPem && !config.caPem.includes("-----BEGIN CERTIFICATE-----")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["caPem"],
          message: "caPem must be a PEM certificate bundle",
        });
      }
    }),
  enabled: z.boolean().optional(),
  owner: providerOwnerField,
});

const gitlabConfigSchema = z.object({
  source: z.literal("gitlab"),
  config: z
    .object({
      host: z.string().min(1).refine(isSsrfSafeHost, {
        message: "Host must not target private or internal addresses",
      }),
      token: z.string().min(1),
      projectPath: z.string().min(1).optional(),
      groupPath: z
        .string()
        .min(1)
        .optional()
        .describe("A group instead of a project: the issues of all its projects"),
      label: z.string().optional(),
      maxPages: z.number().int().positive().optional(),
    })
    .refine((c) => !!c.projectPath || !!c.groupPath, {
      message: "Give a projectPath or a groupPath",
      path: ["projectPath"],
    }),
  enabled: z.boolean().optional(),
  owner: providerOwnerField,
});

const githubConfigSchema = z.object({
  source: z.literal("github"),
  config: z.object({
    token: z.string().optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    label: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
  }),
  enabled: z.boolean().optional(),
  owner: providerOwnerField,
});

const linearConfigSchema = z.object({
  source: z.literal("linear"),
  config: z.object({
    apiKey: z.string().min(1),
    teamId: z.string().optional(),
    projectId: z.string().optional(),
    label: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
    repoUrl: z.string().url().optional(),
  }),
  enabled: z.boolean().optional(),
  owner: providerOwnerField,
});

const notionConfigSchema = z.object({
  source: z.literal("notion"),
  config: z.object({
    apiKey: z.string().min(1),
    databaseId: z.string().min(1),
    label: z.string().optional(),
    statusProperty: z.string().optional(),
    doneValue: z.string().optional(),
    titleProperty: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
    repoUrl: z.string().url().optional(),
  }),
  enabled: z.boolean().optional(),
  owner: providerOwnerField,
});

export const ticketProviderConfigSchema = z
  .discriminatedUnion("source", [
    jiraConfigSchema,
    gitlabConfigSchema,
    githubConfigSchema,
    linearConfigSchema,
    notionConfigSchema,
  ])
  .describe("Ticket provider configuration (discriminated by `source`)");

const ProviderListResponseSchema = z.object({ providers: z.array(TicketProviderSchema) });
const ProviderResponseSchema = z.object({ provider: TicketProviderSchema });
const SyncResponseSchema = z
  .object({ synced: z.unknown() })
  .describe("Aggregated sync counts by provider");
const WebhookOkResponseSchema = z.object({ ok: z.boolean() });
const ProviderTestResponseSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    serverTitle: z.string().optional(),
    version: z.string().optional(),
    deploymentType: z.string().optional(),
    user: z.string().optional(),
  })
  .describe("What a ticket provider connection test found");

/**
 * Fields per provider type that contain credentials and must be encrypted.
 * A row saved before its field was listed here still carries the value in
 * plaintext; `resolveProviderConfig` keeps using it, and the list never
 * returns it (`withoutCredentials`).
 */
const SENSITIVE_PROVIDER_FIELDS: Record<string, string[]> = {
  github: ["token"],
  gitlab: ["token"],
  jira: ["apiToken"],
  linear: ["apiKey"],
  notion: ["apiKey"],
};

export async function verifyGitHubSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): Promise<boolean> {
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;
  const sigBytes = Buffer.from(signature.slice(prefix.length), "hex");

  const verifier = new HmacSha256Verifier(secret);
  return verifier.verify(rawBody, sigBytes);
}

/** A provider row as the list returns it: no credential, even one an older row kept in its config. */
export function withoutCredentials<T extends { source: string; config: unknown }>(row: T): T {
  const fields = SENSITIVE_PROVIDER_FIELDS[row.source] ?? [];
  if (!fields.length || !row.config || typeof row.config !== "object") return row;
  const config = { ...(row.config as Record<string, unknown>) };
  for (const f of fields) delete config[f];
  return { ...row, config };
}

/**
 * The providers `actor` may see: their workspace's (each by its owner, the
 * rule of services/ownership.ts) and the deployment's (no workspace).
 */
export function visibleProviders(actor: Actor) {
  const deployment = isNull(ticketProviders.workspaceId);
  if (!actor.workspaceId) return deployment;
  // `and` drops an undefined term: a workspace admin sees every owner's.
  return or(
    deployment,
    and(
      eq(ticketProviders.workspaceId, actor.workspaceId),
      visibleOwner(ticketProviders.ownerUserId, actor, ticketProviders.ownerTeamId),
    ),
  );
}

/**
 * Whether `requireDeploymentAdmin` lets the request through, for the routes
 * that decide per row: the same gate, asked without answering the request.
 */
async function actsAsDeploymentAdmin(req: FastifyRequest): Promise<boolean> {
  let refused = false;
  const probe = {
    status: () => probe,
    code: () => probe,
    send: () => {
      refused = true;
      return probe;
    },
  };
  await requireDeploymentAdmin(req, probe as unknown as FastifyReply);
  return !refused;
}

type ProviderOwnerRow = {
  workspaceId: string | null;
  ownerUserId: string | null;
  ownerTeamId: string | null;
};

/**
 * Why the caller may not add, change or remove this provider, or null when
 * they may. The deployment's (no workspace) needs a deployment admin, as
 * before providers had owners: anyone may make a workspace and be its admin.
 * A workspace's needs that workspace's admin, a team's its team admins, a
 * person's that person (and a workspace admin may remove anyone's).
 */
export async function providerChangeRefusal(
  req: FastifyRequest,
  row: ProviderOwnerRow,
  action: "edit" | "delete" = "edit",
): Promise<string | null> {
  if (!row.workspaceId) {
    return (await actsAsDeploymentAdmin(req))
      ? null
      : "Only a deployment admin can change the deployment's ticket providers";
  }
  const actor = actorOf(req);
  if (actor.workspaceId !== row.workspaceId) return "Provider not found";
  const ok = canChange(row.ownerUserId, actor, actor.isAdmin, action, {
    ownerTeamId: row.ownerTeamId,
    orgNeeds: "admin",
  });
  return ok ? null : changeRefusal(row.ownerUserId, "ticket provider", "admin", row.ownerTeamId);
}

/** The provider `id` when the caller may `action` it; otherwise the 404 or 403 is sent. */
export async function changeableProvider(
  id: string,
  req: FastifyRequest,
  reply: FastifyReply,
  action: "edit" | "delete" = "edit",
) {
  const [row] = await db
    .select()
    .from(ticketProviders)
    .where(and(eq(ticketProviders.id, id), visibleProviders(actorOf(req))));
  if (!row) {
    reply.status(404).send({ error: "Provider not found" });
    return null;
  }
  const refusal = await providerChangeRefusal(req, row, action);
  if (refusal) {
    reply.status(403).send({ error: refusal });
    return null;
  }
  return row;
}

export async function ticketRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/tickets/providers",
    {
      schema: {
        operationId: "listTicketProviders",
        summary: "List configured ticket providers",
        description:
          "Return the ticket provider connections the caller may see: the deployment's, " +
          "their workspace's, their teams' and their own (every one in the workspace for a " +
          "workspace admin), each with its owner's name. Credentials are never returned.",
        tags: ["Repos & Integrations"],
        response: { 200: ProviderListResponseSchema },
      },
    },
    async (req, reply) => {
      const providers = (
        await withOwnerNames(
          await db
            .select()
            .from(ticketProviders)
            .where(visibleProviders(actorOf(req))),
        )
      ).map(withoutCredentials);

      // Annotate each provider with auth failure status from both:
      // 1. The provider row itself (last_error, consecutive_failures)
      // 2. Legacy auth_events table for backwards compat
      const cutoff = new Date(Date.now() - RECENT_AUTH_FAILURE_WINDOW_MS);
      const failedRows = await db
        .selectDistinct({ source: authEvents.source })
        .from(authEvents)
        .where(
          and(gt(authEvents.createdAt, cutoff), sql`${authEvents.source} LIKE 'ticket-sync:%'`),
        );
      const failedIds = new Set(
        failedRows.map((r) => r.source?.replace("ticket-sync:", "")).filter(Boolean),
      );
      const annotated = providers.map((p) => ({
        ...p,
        hasAuthFailure: failedIds.has(p.id) || (p.consecutiveFailures ?? 0) > 0,
      }));

      reply.send({ providers: annotated });
    },
  );

  app.post(
    "/api/tickets/sync",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "syncTicketProviders",
        summary: "Force a ticket sync",
        description:
          "Trigger an immediate sync across all enabled ticket providers. Useful " +
          "for debugging — the sync worker runs this automatically on a schedule.",
        tags: ["Repos & Integrations"],
        response: { 200: SyncResponseSchema },
      },
    },
    async (_req, reply) => {
      const synced = await syncAllTickets();
      reply.send({ synced });
    },
  );

  app.post(
    "/api/tickets/providers",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createTicketProvider",
        summary: "Configure a ticket provider",
        description:
          "Register a new ticket provider (jira, gitlab, github, linear, notion). " +
          "Sensitive fields (API tokens) are stored as encrypted secrets " +
          "linked to the provider record. `owner` says whose it is: the workspace's " +
          "(a workspace admin), a team's (`team:<id>`, its team admins) or the caller's " +
          "(`me`); its tickets become that owner's tasks, on the workspace's repositories. " +
          "A deployment admin's organization provider is the deployment's, as before owners.",
        tags: ["Repos & Integrations"],
        body: ticketProviderConfigSchema,
        response: {
          201: ProviderResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      // A ticket source the deployment leaves out (OPTIO_TICKET_SOURCES).
      const unavailable = ticketSourceRefusal(body.source);
      if (unavailable) return reply.status(400).send({ error: unavailable });
      const actor = actorOf(req);
      let owner: { ownerUserId: string | null; ownerTeamId: string | null };
      try {
        owner = ownerColumnsForNew(body.owner, actor);
      } catch (err) {
        if (err instanceof OwnerError) return reply.status(403).send({ error: err.message });
        throw err;
      }
      // A deployment admin's organization provider stays the deployment's, as
      // every provider was before they had owners; anyone else's is their
      // workspace's.
      const deploymentWide =
        !owner.ownerUserId &&
        !owner.ownerTeamId &&
        (!actor.workspaceId || (await actsAsDeploymentAdmin(req)));
      const workspaceId = deploymentWide ? null : (actor.workspaceId ?? null);
      if (!workspaceId && (owner.ownerUserId || owner.ownerTeamId)) {
        return reply
          .status(400)
          .send({ error: "A person's or a team's provider belongs to a workspace" });
      }
      const refusal = await providerChangeRefusal(req, { workspaceId, ...owner });
      if (refusal) return reply.status(403).send({ error: refusal });
      // Only the deployment's own providers fall back to the server's GitHub token.
      if (workspaceId && body.source === "github" && !body.config.token) {
        return reply.status(400).send({ error: "Give the provider a GitHub token" });
      }

      const sensitiveFields = SENSITIVE_PROVIDER_FIELDS[body.source] ?? [];
      const safeConfig: Record<string, unknown> = { ...body.config };
      const sensitiveValues: Record<string, string> = {};

      for (const field of sensitiveFields) {
        if (safeConfig[field]) {
          sensitiveValues[field] = safeConfig[field] as string;
          delete safeConfig[field];
        }
      }

      const [provider] = await db
        .insert(ticketProviders)
        .values({
          source: body.source,
          config: safeConfig,
          enabled: body.enabled ?? true,
          workspaceId,
          ...owner,
        })
        .returning();

      if (Object.keys(sensitiveValues).length > 0) {
        await storeSecret(
          `ticket-provider:${provider.id}`,
          JSON.stringify(sensitiveValues),
          "ticket-provider",
        );
      }

      reply.status(201).send({ provider: withoutCredentials(provider) });
    },
  );

  app.delete(
    "/api/tickets/providers/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "deleteTicketProvider",
        summary: "Delete a ticket provider",
        description:
          "Delete a ticket provider and its encrypted credentials. The deployment's needs a " +
          "deployment admin, a workspace's its workspace admin, a team's its team admins (or a " +
          "workspace admin), a person's that person (or a workspace admin).",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!(await changeableProvider(id, req, reply, "delete"))) return;
      await db.delete(ticketProviders).where(eq(ticketProviders.id, id));
      await deleteSecret(`ticket-provider:${id}`, "ticket-provider");
      reply.status(204).send(null);
    },
  );

  app.patch(
    "/api/tickets/providers/:id/re-enable",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "reEnableTicketProvider",
        summary: "Re-enable a ticket provider",
        description:
          "Clear error state and re-enable a ticket provider that was auto-disabled " +
          "after consecutive sync failures. Use after refreshing the provider's token.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: {
          200: ProviderResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!(await changeableProvider(id, req, reply))) return;
      const [provider] = await db
        .update(ticketProviders)
        .set({
          enabled: true,
          lastError: null,
          lastErrorAt: null,
          consecutiveFailures: 0,
        })
        .where(eq(ticketProviders.id, id))
        .returning();
      if (!provider) {
        return reply.status(404).send({ error: "Provider not found" });
      }
      reply.send({ provider: withoutCredentials(provider) });
    },
  );

  app.post(
    "/api/tickets/providers/:id/test",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "testTicketProvider",
        summary: "Test a ticket provider's connection",
        description:
          "Reach the provider with the stored config and its encrypted credentials " +
          "and report what answered (for Jira: the server, its version and the " +
          "account). A failed test is a 200 with `ok: false` and the reason. Whoever may " +
          "change the provider may test it.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: {
          200: ProviderTestResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const row = await changeableProvider(req.params.id, req, reply);
      if (!row) return;
      const provider = getTicketProvider(row.source as TicketSource);
      if (!provider.testConnection) {
        return reply.send({ ok: false, error: `${row.source} providers have no connection test` });
      }
      reply.send(await provider.testConnection(await resolveProviderConfig(row)));
    },
  );

  // GitHub webhook — hidden from spec because request body is verified via HMAC
  // and response is trivial. Uses preParsing to capture the raw bytes for the
  // signature check before JSON parsing.
  // Never registered when OPTIO_TRIGGERS leaves out GitHub: a delivery answers 404.
  receiverFor(app, "github").post("/api/webhooks/github", {
    schema: {
      hide: true,
      operationId: "githubWebhook",
      summary: "GitHub webhook receiver",
      description:
        "Inbound webhook endpoint for GitHub issue and PR events. Secured via " +
        "HMAC-SHA256 signature. Hidden from the public spec.",
      tags: ["Repos & Integrations"],
      response: { 200: WebhookOkResponseSchema, 401: ErrorResponseSchema },
    },
    // Bounded by the route's bodyLimit while reading (the endpoint is public).
    preParsing: captureRawBody,
    handler: async (req, reply) => {
      const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

      if (!webhookSecret) {
        logger.error("GITHUB_WEBHOOK_SECRET is not set — rejecting webhook request");
        return reply.status(401).send({ error: "Webhook secret not configured" });
      }

      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!signature) {
        logger.warn("Webhook request missing X-Hub-Signature-256 header");
        return reply.status(401).send({ error: "Missing signature" });
      }

      const rawBody = rawBodyOf(req);
      if (!(await verifyGitHubSignature(rawBody, signature, webhookSecret))) {
        logger.warn("Webhook signature verification failed");
        return reply.status(401).send({ error: "Invalid signature" });
      }

      const event = req.headers["x-github-event"];
      const rawPayload = req.body;
      const payload = rawPayload as Record<string, Record<string, unknown> | string | undefined>;
      if (typeof event === "string") {
        const { normalizeGitHubEvent } = await import("../services/event-trigger-service.js");
        const { acceptTriggerEvent } = await import("../services/trigger-delivery.js");
        const normalized = normalizeGitHubEvent(event, rawPayload);
        if (normalized)
          await acceptTriggerEvent(
            "github",
            typeof req.headers["x-github-delivery"] === "string"
              ? req.headers["x-github-delivery"]
              : undefined,
            normalized,
          );
      }

      // GitHub signs no timestamp, so a captured delivery stays validly
      // signed forever. Drop replays (and GitHub's own redeliveries) by the
      // unique X-GitHub-Delivery id, claimed in the database so every API
      // instance sees the claim.
      const delivery = req.headers["x-github-delivery"];
      if (typeof delivery === "string" && !(await claimDelivery("github", delivery))) {
        logger.info({ delivery }, "Ignoring already-processed GitHub delivery");
        return reply.status(200).send({ ok: true });
      }

      if (event === "issues" && payload.action === "labeled") {
        const label = (payload.label as Record<string, unknown> | undefined)?.name;
        if (label === "optio") {
          logger.info(
            { issue: (payload.issue as Record<string, unknown> | undefined)?.number },
            "GitHub issue labeled with optio",
          );
          await syncAllTickets();
        }
      }

      if (
        event === "pull_request" &&
        payload.action === "closed" &&
        (payload.pull_request as Record<string, unknown> | undefined)?.merged
      ) {
        const prUrl = String((payload.pull_request as Record<string, unknown>).html_url ?? "");
        const matchingTask = await taskService.getTaskByPrUrl(prUrl);

        if (matchingTask) {
          try {
            await taskService.transitionTask(
              matchingTask.id,
              TaskState.COMPLETED,
              "pr_merged",
              prUrl,
            );
            logger.info({ taskId: matchingTask.id, prUrl }, "Task completed via PR merge");
          } catch {
            // May already be completed
          }
        }
      }

      reply.status(200).send({ ok: true });
    },
  });
}
