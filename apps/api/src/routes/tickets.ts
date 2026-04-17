import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { and, eq, gt, sql } from "drizzle-orm";
import { Readable } from "node:stream";
import { db } from "../db/client.js";
import { ticketProviders, authEvents } from "../db/schema.js";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import { syncAllTickets } from "../services/ticket-sync-service.js";
import { storeSecret, deleteSecret } from "../services/secret-service.js";
import { RECENT_AUTH_FAILURE_WINDOW_MS } from "../services/auth-failure-detector.js";
import { isSsrfSafeUrl, isSsrfSafeHost } from "../utils/ssrf.js";
import { HmacSha256Verifier } from "../services/crypto/signer.js";
import { logger } from "../logger.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { TicketProviderSchema } from "../schemas/integration.js";

// ── Zod schemas for ticket provider config ─────────────────────────────────

const jiraConfigSchema = z.object({
  source: z.literal("jira"),
  config: z.object({
    baseUrl: z.string().url().refine(isSsrfSafeUrl, {
      message: "URL must not target private or internal addresses",
    }),
    email: z.string().email(),
    apiToken: z.string().min(1),
    projectKey: z.string().optional(),
    label: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
    doneStatusName: z.string().optional(),
    todoStatusName: z.string().optional(),
  }),
  enabled: z.boolean().optional(),
});

const gitlabConfigSchema = z.object({
  source: z.literal("gitlab"),
  config: z.object({
    host: z.string().min(1).refine(isSsrfSafeHost, {
      message: "Host must not target private or internal addresses",
    }),
    token: z.string().min(1),
    projectPath: z.string().min(1),
    label: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
  }),
  enabled: z.boolean().optional(),
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
});

const linearConfigSchema = z.object({
  source: z.literal("linear"),
  config: z.object({
    apiKey: z.string().min(1),
    teamId: z.string().optional(),
    projectId: z.string().optional(),
    label: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
  }),
  enabled: z.boolean().optional(),
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
  }),
  enabled: z.boolean().optional(),
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

/** Fields per provider type that contain credentials and must be encrypted. */
const SENSITIVE_PROVIDER_FIELDS: Record<string, string[]> = {
  github: ["token"],
  jira: ["apiToken"],
  linear: ["apiKey"],
  notion: ["apiKey"],
};

/** Maximum age (in minutes) for a webhook event before it is rejected. */
const WEBHOOK_MAX_AGE_MINUTES = 5;

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

export function isReplayedEvent(
  timestampHeader: string | undefined,
  maxAgeMinutes: number = WEBHOOK_MAX_AGE_MINUTES,
): boolean {
  if (!timestampHeader) return false;
  const ts = Number(timestampHeader);
  if (Number.isNaN(ts)) return false;
  const ageMs = Date.now() - ts * 1000;
  return ageMs > maxAgeMinutes * 60 * 1000;
}

export async function ticketRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/tickets/providers",
    {
      schema: {
        operationId: "listTicketProviders",
        summary: "List configured ticket providers",
        description: "Return all ticket provider connections.",
        tags: ["Repos & Integrations"],
        response: { 200: ProviderListResponseSchema },
      },
    },
    async (_req, reply) => {
      const providers = await db.select().from(ticketProviders);

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
      schema: {
        operationId: "createTicketProvider",
        summary: "Configure a ticket provider",
        description:
          "Register a new ticket provider (jira, gitlab, github, linear, notion). " +
          "Sensitive fields (API tokens) are stored as encrypted secrets " +
          "linked to the provider record.",
        tags: ["Repos & Integrations"],
        body: ticketProviderConfigSchema,
        response: { 201: ProviderResponseSchema },
      },
    },
    async (req, reply) => {
      const body = req.body;

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
        })
        .returning();

      if (Object.keys(sensitiveValues).length > 0) {
        await storeSecret(
          `ticket-provider:${provider.id}`,
          JSON.stringify(sensitiveValues),
          "ticket-provider",
        );
      }

      reply.status(201).send({ provider });
    },
  );

  app.delete(
    "/api/tickets/providers/:id",
    {
      schema: {
        operationId: "deleteTicketProvider",
        summary: "Delete a ticket provider",
        description: "Delete a ticket provider and its encrypted credentials.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      await db.delete(ticketProviders).where(eq(ticketProviders.id, id));
      await deleteSecret(`ticket-provider:${id}`, "ticket-provider");
      reply.status(204).send(null);
    },
  );

  app.patch(
    "/api/tickets/providers/:id/re-enable",
    {
      schema: {
        operationId: "reEnableTicketProvider",
        summary: "Re-enable a ticket provider",
        description:
          "Clear error state and re-enable a ticket provider that was auto-disabled " +
          "after consecutive sync failures. Use after refreshing the provider's token.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: ProviderResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
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
      reply.send({ provider });
    },
  );

  // GitHub webhook — hidden from spec because request body is verified via HMAC
  // and response is trivial. Uses preParsing to capture the raw bytes for the
  // signature check before JSON parsing.
  app.post("/api/webhooks/github", {
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

      const rawBody = (req as unknown as { rawBody: Buffer }).rawBody;
      if (!(await verifyGitHubSignature(rawBody, signature, webhookSecret))) {
        logger.warn("Webhook signature verification failed");
        return reply.status(401).send({ error: "Invalid signature" });
      }

      const timestamp = req.headers["x-github-delivery-timestamp"] as string | undefined;
      if (isReplayedEvent(timestamp)) {
        logger.warn({ timestamp }, "Rejecting replayed webhook event");
        return reply.status(401).send({ error: "Replayed event" });
      }

      const event = req.headers["x-github-event"];
      const rawPayload = req.body;
      const payload = rawPayload as Record<string, Record<string, unknown> | string | undefined>;

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
        const allTasks = await taskService.listTasks({ limit: 500 });
        const matchingTask = allTasks.find((t) => t.prUrl === prUrl);

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
