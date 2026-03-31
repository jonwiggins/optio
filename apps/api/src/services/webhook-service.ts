import crypto from "node:crypto";
import { eq, desc } from "drizzle-orm";
import { assertSsrfSafe } from "../utils/ssrf.js";
import { db } from "../db/client.js";
import { webhooks, webhookDeliveries } from "../db/schema.js";
import { encrypt, decrypt } from "./secret-service.js";
import { logger } from "../logger.js";

export type WebhookEvent =
  | "task.completed"
  | "task.failed"
  | "task.needs_attention"
  | "task.pr_opened"
  | "review.completed";

export const VALID_EVENTS: WebhookEvent[] = [
  "task.completed",
  "task.failed",
  "task.needs_attention",
  "task.pr_opened",
  "review.completed",
];

export interface WebhookRecord {
  id: string;
  url: string;
  workspaceId: string | null;
  events: string[];
  secret: string | null;
  description: string | null;
  active: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Decrypt a webhook row's encrypted secret into a WebhookRecord with a plaintext `secret` field.
 */
function decryptWebhookRow(row: typeof webhooks.$inferSelect): WebhookRecord {
  let secret: string | null = null;
  if (row.encryptedSecret && row.secretIv && row.secretAuthTag) {
    secret = decrypt(row.encryptedSecret, row.secretIv, row.secretAuthTag);
  }
  return {
    id: row.id,
    url: row.url,
    workspaceId: row.workspaceId ?? null,
    events: row.events as string[],
    secret,
    description: row.description ?? null,
    active: row.active,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface CreateWebhookInput {
  url: string;
  events: WebhookEvent[];
  secret?: string;
  description?: string;
}

export async function createWebhook(
  input: CreateWebhookInput,
  createdBy?: string,
  workspaceId?: string | null,
): Promise<WebhookRecord> {
  let encryptedSecret: Buffer | null = null;
  let secretIv: Buffer | null = null;
  let secretAuthTag: Buffer | null = null;

  if (input.secret) {
    const { encrypted, iv, authTag } = encrypt(input.secret);
    encryptedSecret = encrypted;
    secretIv = iv;
    secretAuthTag = authTag;
  }

  const [webhook] = await db
    .insert(webhooks)
    .values({
      url: input.url,
      events: input.events,
      encryptedSecret,
      secretIv,
      secretAuthTag,
      description: input.description ?? null,
      createdBy: createdBy ?? null,
      workspaceId: workspaceId ?? null,
    })
    .returning();
  return decryptWebhookRow(webhook);
}

export async function listWebhooks(workspaceId?: string | null): Promise<WebhookRecord[]> {
  if (workspaceId) {
    const rows = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.workspaceId, workspaceId))
      .orderBy(desc(webhooks.createdAt));
    return rows.map(decryptWebhookRow);
  }
  const rows = await db.select().from(webhooks).orderBy(desc(webhooks.createdAt));
  return rows.map(decryptWebhookRow);
}

export async function getWebhook(id: string): Promise<WebhookRecord | null> {
  const [webhook] = await db.select().from(webhooks).where(eq(webhooks.id, id));
  if (!webhook) return null;
  return decryptWebhookRow(webhook);
}

export async function deleteWebhook(id: string) {
  const result = await db.delete(webhooks).where(eq(webhooks.id, id)).returning();
  return result.length > 0;
}

export async function getWebhookDeliveries(webhookId: string, opts?: { limit?: number }) {
  let query = db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId))
    .orderBy(desc(webhookDeliveries.deliveredAt));
  if (opts?.limit) query = query.limit(opts.limit) as typeof query;
  return query;
}

/**
 * Sign a payload using HMAC-SHA256 with the webhook's secret.
 */
export function signPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Build a Slack-compatible payload with blocks for task details.
 */
function buildSlackPayload(
  event: WebhookEvent,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const taskTitle = (data.taskTitle as string) ?? "Unknown task";
  const taskId = (data.taskId as string) ?? "";
  const repoUrl = (data.repoUrl as string) ?? "";
  const prUrl = data.prUrl as string | undefined;
  const errorMessage = data.errorMessage as string | undefined;

  const statusEmoji: Record<string, string> = {
    "task.completed": ":white_check_mark:",
    "task.failed": ":x:",
    "task.needs_attention": ":warning:",
    "task.pr_opened": ":rocket:",
    "review.completed": ":mag:",
  };

  const statusText: Record<string, string> = {
    "task.completed": "Task Completed",
    "task.failed": "Task Failed",
    "task.needs_attention": "Task Needs Attention",
    "task.pr_opened": "PR Opened",
    "review.completed": "Review Completed",
  };

  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${statusEmoji[event] ?? ""} ${statusText[event] ?? event}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Task:*\n${taskTitle}` },
        { type: "mrkdwn", text: `*ID:*\n\`${taskId}\`` },
      ],
    },
  ];

  if (repoUrl) {
    blocks.push({
      type: "section",
      fields: [{ type: "mrkdwn", text: `*Repository:*\n${repoUrl}` }],
    });
  }

  if (prUrl) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Pull Request:* <${prUrl}|View PR>` },
    });
  }

  if (errorMessage) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Error:*\n\`\`\`${errorMessage.slice(0, 500)}\`\`\``,
      },
    });
  }

  // Slack requires a top-level `text` as fallback for notifications
  return {
    text: `${statusText[event] ?? event}: ${taskTitle}`,
    blocks,
  };
}

/**
 * Determine if a URL is a Slack incoming webhook.
 */
function isSlackWebhook(url: string): boolean {
  return url.includes("hooks.slack.com/");
}

/**
 * Deliver a webhook payload to a single endpoint.
 * Returns the delivery record.
 */
export async function deliverWebhook(
  webhook: WebhookRecord,
  event: WebhookEvent,
  data: Record<string, unknown>,
  attempt: number = 1,
): Promise<typeof webhookDeliveries.$inferSelect> {
  const isSlack = isSlackWebhook(webhook.url);
  const payload = isSlack
    ? buildSlackPayload(event, data)
    : { event, timestamp: new Date().toISOString(), data };

  const payloadStr = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Optio-Webhooks/1.0",
    "X-Optio-Event": event,
  };

  if (webhook.secret) {
    headers["X-Optio-Signature"] = signPayload(payloadStr, webhook.secret);
  }

  let statusCode: number | undefined;
  let responseBody: string | undefined;
  let success = false;
  let error: string | undefined;

  try {
    // SSRF protection: verify URL does not resolve to a private/internal address
    await assertSsrfSafe(webhook.url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s timeout

    const res = await fetch(webhook.url, {
      method: "POST",
      headers,
      body: payloadStr,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    statusCode = res.status;
    responseBody = await res.text().catch(() => undefined);
    // Truncate response body to avoid storing huge payloads
    if (responseBody && responseBody.length > 2000) {
      responseBody = responseBody.slice(0, 2000) + "...(truncated)";
    }
    success = res.ok;
    if (!res.ok) {
      error = `HTTP ${res.status}: ${responseBody?.slice(0, 200) ?? ""}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.warn({ webhookId: webhook.id, event, attempt, error }, "Webhook delivery failed");
  }

  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      webhookId: webhook.id,
      event,
      payload,
      statusCode,
      responseBody,
      success,
      attempt,
      error,
    })
    .returning();

  return delivery;
}

/**
 * Find all active webhooks subscribed to an event and dispatch delivery jobs.
 */
export async function getWebhooksForEvent(event: WebhookEvent): Promise<WebhookRecord[]> {
  const allWebhooks = await db.select().from(webhooks).where(eq(webhooks.active, true));

  return allWebhooks
    .filter((w) => {
      const events = w.events as string[];
      return events.includes(event);
    })
    .map(decryptWebhookRow);
}
