import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { Readable } from "node:stream";
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
import { ErrorResponseSchema, IdParamsSchema, ResourceOwnerSchema } from "../schemas/common.js";
import { TicketProviderSchema } from "../schemas/integration.js";
import { requireRole } from "../plugins/auth.js";
import { receiverFor, ticketSourceRefusal } from "../services/feature-guard.js";
// The audit trail (docs/audit.md).
import { auditEvent, ownerDetails } from "../services/audit.js";
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
 * Whose a ticket provider is (services/ownership.ts): the organization's
 * (`workspace`, the default — a workspace admin adds it), a team's
 * (`team:<id>` — its team admins) or the caller's own (`me`). The tasks its
 * tickets become are its owner's (ticket-sync-service.ts), so a team's Jira
 * fills the team's work.
 */
const providerOwnerField = ResourceOwnerSchema.optional().describe(
  'Whose it is: "workspace" (the organization\'s; default), "me", or "team:<id>"',
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
      // Blank: its owner's GITLAB_TOKEN (the team's or the person's own, the
      // organization's for the organization's), on a GitLab this deployment uses.
      token: z.string().min(1).optional(),
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
 * plaintext; `resolveProviderConfig` keeps it when no secret is stored.
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

/** The providers `actor` may see: their workspace's (and legacy rows without one), by owner. */
export function visibleProviders(actor: Actor) {
  return and(
    actor.workspaceId
      ? or(isNull(ticketProviders.workspaceId), eq(ticketProviders.workspaceId, actor.workspaceId))
      : undefined,
    visibleOwner(ticketProviders.ownerUserId, actor, ticketProviders.ownerTeamId),
  );
}

/**
 * Who may add, change or remove a provider: the organization's needs a
 * workspace admin, a team's its team admins, a person's that person (and a
 * workspace admin may remove anyone's).
 */
export function mayChangeProvider(
  row: { ownerUserId: string | null; ownerTeamId: string | null },
  actor: Actor,
  action: "edit" | "delete" = "edit",
): boolean {
  return canChange(row.ownerUserId, actor, actor.isAdmin, action, {
    ownerTeamId: row.ownerTeamId,
    orgNeeds: "admin",
  });
}

export async function ticketRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  /** The provider `id` when the caller may `action` it; otherwise the reply is sent. */
  const changeable = async (
    id: string,
    actor: Actor,
    reply: FastifyReply,
    action: "edit" | "delete" = "edit",
  ) => {
    const [row] = await db
      .select()
      .from(ticketProviders)
      .where(and(eq(ticketProviders.id, id), visibleProviders(actor)));
    if (!row) {
      reply.status(404).send({ error: "Provider not found" });
      return null;
    }
    if (!mayChangeProvider(row, actor, action)) {
      reply.status(403).send({
        error: changeRefusal(row.ownerUserId, "ticket provider", "admin", row.ownerTeamId),
      });
      return null;
    }
    return row;
  };

  app.get(
    "/api/tickets/providers",
    {
      schema: {
        operationId: "listTicketProviders",
        summary: "List configured ticket providers",
        description:
          "Return the ticket provider connections the caller may see: the organization's, " +
          "their teams' and their own (every one for a workspace admin), each with its " +
          "owner's name.",
        tags: ["Repos & Integrations"],
        response: { 200: ProviderListResponseSchema },
      },
    },
    async (req, reply) => {
      const providers = await withOwnerNames(
        await db
          .select()
          .from(ticketProviders)
          .where(visibleProviders(actorOf(req))),
      );

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
          "linked to the provider record. `owner` says whose it is: the organization's " +
          "(a workspace admin), a team's (`team:<id>`, its team admins) or the caller's " +
          "(`me`); the tasks its tickets become are that owner's.",
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
      if (!mayChangeProvider(owner, actor)) {
        return reply.status(403).send({
          error: changeRefusal(owner.ownerUserId, "ticket provider", "admin", owner.ownerTeamId),
        });
      }
      // A GitLab provider without a token borrows a GITLAB_TOKEN, which only
      // ever goes to a GitLab this deployment uses (ticket-sync-service.ts).
      if (body.source === "gitlab" && !body.config.token) {
        const { isKnownGitLabHost } = await import("../services/git-token-service.js");
        if (!(await isKnownGitLabHost(body.config.host, actor.workspaceId ?? null))) {
          return reply.status(400).send({
            error:
              `Give the provider a token: ${body.config.host} is not a GitLab this deployment ` +
              "uses (GITLAB_HOST, GITLAB_HOSTS or the host of an added GitLab repo)",
          });
        }
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
          workspaceId: actor.workspaceId,
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
      // The audit trail (docs/audit.md); never the token.
      void auditEvent({
        req,
        action: "ticket_provider.create",
        details: { id: provider.id, type: provider.source, ...ownerDetails(req, provider) },
      });

      reply.status(201).send({ provider });
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
          "Delete a ticket provider and its encrypted credentials. The organization's needs a " +
          "workspace admin, a team's its team admins (or a workspace admin), a person's that " +
          "person (or a workspace admin).",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 403: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const row = await changeable(id, actorOf(req), reply, "delete");
      if (!row) return;
      await db.delete(ticketProviders).where(eq(ticketProviders.id, id));
      await deleteSecret(`ticket-provider:${id}`, "ticket-provider");
      // The audit trail (docs/audit.md).
      void auditEvent({
        req,
        action: "ticket_provider.delete",
        details: { id, type: row.source, ...ownerDetails(req, row) },
      });
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
      if (!(await changeable(id, actorOf(req), reply))) return;
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
      // The audit trail (docs/audit.md).
      void auditEvent({
        req,
        action: "ticket_provider.enable",
        details: { id, type: provider.source, ...ownerDetails(req, provider) },
      });
      reply.send({ provider });
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
          "account). A failed test is a 200 with `ok: false` and the reason.",
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
      const { id } = req.params;
      const row = await changeable(id, actorOf(req), reply);
      if (!row) return;

      const provider = getTicketProvider(row.source as TicketSource);
      if (!provider.testConnection) {
        return reply.send({ ok: false, error: `${row.source} providers have no connection test` });
      }
      const config = await resolveProviderConfig(row);
      reply.send(await provider.testConnection(config));
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
    preParsing: async (req, _reply, payload) => {
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const rawBody = Buffer.concat(chunks);
      (req as unknown as { rawBody: Buffer }).rawBody = rawBody;
      return Readable.from(rawBody);
    },
    handler: async (req, reply) => {
      // The deployment's GITHUB_WEBHOOK_SECRET, else the one Optio generated
      // for the repository hooks it registers (opt-in, repo-webhook-service.ts).
      const webhookSecret =
        process.env.GITHUB_WEBHOOK_SECRET ||
        (await import("../services/webhook-secret-service.js").then((m) =>
          m.githubWebhookSecret(),
        ));

      if (!webhookSecret) {
        logger.error("GITHUB_WEBHOOK_SECRET is not set — rejecting webhook request");
        return reply.status(401).send({ error: "Webhook secret not configured" });
      }

      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!signature) {
        logger.warn("Webhook request missing X-Hub-Signature-256 header");
        return reply.status(401).send({ error: "Missing signature" });
      }

      const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
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

      // A comment mentioning Optio's GitHub bot, when it is on
      // (services/gitlab-bot/, docs/gitlab-bot.md; off by default).
      if (event === "issue_comment") {
        const { acceptGitHubMention } = await import("../services/gitlab-bot/ingress.js");
        await acceptGitHubMention(rawPayload, typeof delivery === "string" ? delivery : undefined);
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
