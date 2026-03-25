import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { db } from "../db/client.js";
import { ticketProviders } from "../db/schema.js";
import { TaskState } from "@optio/shared";
import * as taskService from "../services/task-service.js";
import { syncAllTickets } from "../services/ticket-sync-service.js";
import { logger } from "../logger.js";

/** Maximum age (in minutes) for a webhook event before it is rejected. */
const WEBHOOK_MAX_AGE_MINUTES = 5;

/**
 * Verify the HMAC-SHA256 signature sent by GitHub in the X-Hub-Signature-256
 * header against the raw request body and the configured secret.
 */
export function verifyGitHubSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Check whether the webhook delivery timestamp is within the acceptable window.
 * Returns true if the event should be rejected (too old or too far in the future).
 */
export function isReplayedEvent(
  timestampHeader: string | undefined,
  maxAgeMinutes: number = WEBHOOK_MAX_AGE_MINUTES,
): boolean {
  if (!timestampHeader) return false;
  const ts = Number(timestampHeader);
  if (Number.isNaN(ts)) return false;
  const ageMs = Date.now() - ts * 1000;
  // Reject events older than the tolerance window
  if (ageMs > maxAgeMinutes * 60 * 1000) return true;
  // Reject events with timestamps far in the future (clock-skew attack)
  if (ageMs < -(maxAgeMinutes * 60 * 1000)) return true;
  return false;
}

export async function ticketRoutes(app: FastifyInstance) {
  // List configured ticket providers
  app.get("/api/tickets/providers", async (_req, reply) => {
    const providers = await db.select().from(ticketProviders);
    reply.send({ providers });
  });

  // Sync tickets from all enabled providers
  app.post("/api/tickets/sync", async (_req, reply) => {
    const synced = await syncAllTickets();
    reply.send({ synced });
  });

  // Configure a ticket provider
  app.post("/api/tickets/providers", async (req, reply) => {
    const body = req.body as { source: string; config: Record<string, unknown>; enabled?: boolean };
    const [provider] = await db
      .insert(ticketProviders)
      .values({
        source: body.source,
        config: body.config,
        enabled: body.enabled ?? true,
      })
      .returning();
    reply.status(201).send({ provider });
  });

  // Delete a ticket provider
  app.delete("/api/tickets/providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(ticketProviders).where(eq(ticketProviders.id, id));
    reply.status(204).send();
  });

  // GitHub webhook endpoint for real-time ticket events
  app.post("/api/webhooks/github", {
    // Capture raw body before JSON parsing so we can verify the HMAC signature
    preParsing: async (req, _reply, payload) => {
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
      }
      const rawBody = Buffer.concat(chunks);
      (req as any).rawBody = rawBody;
      return Readable.from(rawBody);
    },
    handler: async (req, reply) => {
      const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

      if (!webhookSecret) {
        logger.error("GITHUB_WEBHOOK_SECRET is not set — rejecting webhook request");
        return reply.status(401).send({ error: "Webhook secret not configured" });
      }

      // Validate HMAC-SHA256 signature
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!signature) {
        logger.warn("Webhook request missing X-Hub-Signature-256 header");
        return reply.status(401).send({ error: "Missing signature" });
      }

      const rawBody = (req as any).rawBody as Buffer;
      if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
        logger.warn("Webhook signature verification failed");
        return reply.status(401).send({ error: "Invalid signature" });
      }

      // Replay protection — reject events with stale timestamps
      const timestamp = req.headers["x-github-delivery-timestamp"] as string | undefined;
      if (isReplayedEvent(timestamp)) {
        logger.warn({ timestamp }, "Rejecting replayed webhook event");
        return reply.status(401).send({ error: "Replayed event" });
      }

      const event = req.headers["x-github-event"];
      const payload = req.body as any;

      if (event === "issues" && payload.action === "labeled") {
        const label = payload.label?.name;
        if (label === "optio") {
          logger.info({ issue: payload.issue?.number }, "GitHub issue labeled with optio");
          // Trigger a sync — handles deduplication
          await syncAllTickets();
        }
      }

      if (event === "pull_request" && payload.action === "closed" && payload.pull_request?.merged) {
        const prUrl = payload.pull_request.html_url;
        const allTasks = await taskService.listTasks({ limit: 500 });
        const matchingTask = allTasks.find((t: any) => t.prUrl === prUrl);

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
