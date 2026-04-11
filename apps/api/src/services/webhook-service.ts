import { eq, desc } from "drizzle-orm";
import { assertSsrfSafe } from "../utils/ssrf.js";
import { db } from "../db/client.js";
import { webhooks, webhookDeliveries } from "../db/schema.js";
import { encrypt, decrypt, ALG_AES_256_GCM_V1 } from "./secret-service.js";
import { HmacSha256Signer } from "./crypto/signer.js";
import { logger } from "../logger.js";

export type WebhookEvent =
  | "task.completed"
  | "task.failed"
  | "task.needs_attention"
  | "task.pr_opened"
  | "review.completed"
  | "workflow_run.queued"
  | "workflow_run.started"
  | "workflow_run.completed"
  | "workflow_run.failed";

export const VALID_EVENTS: WebhookEvent[] = [
  "task.completed",
  "task.failed",
  "task.needs_attention",
  "task.pr_opened",
  "review.completed",
  "workflow_run.queued",
  "workflow_run.started",
  "workflow_run.completed",
  "workflow_run.failed",
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
    const aad = Buffer.from(`webhook:${row.url}:secret`);
    secret = decrypt(
      {
        alg: row.secretAlg ?? ALG_AES_256_GCM_V1,
        iv: row.secretIv,
        ciphertext: row.encryptedSecret,
        authTag: row.secretAuthTag,
      },
      aad,
    );
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

  let secretAlg: number = ALG_AES_256_GCM_V1;

  if (input.secret) {
    const aad = Buffer.from(`webhook:${input.url}:secret`);
    const blob = encrypt(input.secret, aad);
    encryptedSecret = blob.ciphertext;
    secretIv = blob.iv;
    secretAuthTag = blob.authTag;
    secretAlg = blob.alg;
  }

  const [webhook] = await db
    .insert(webhooks)
    .values({
      url: input.url,
      events: input.events,
      encryptedSecret,
      secretIv,
      secretAuthTag,
      secretAlg,
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

export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookEvent[];
  secret?: string | null;
  description?: string | null;
  active?: boolean;
}

export async function updateWebhook(
  id: string,
  input: UpdateWebhookInput,
): Promise<WebhookRecord | null> {
  const existing = await db.select().from(webhooks).where(eq(webhooks.id, id));
  if (existing.length === 0) return null;

  const updates: Partial<typeof webhooks.$inferInsert> = { updatedAt: new Date() };

  if (input.url !== undefined) updates.url = input.url;
  if (input.events !== undefined) updates.events = input.events;
  if (input.description !== undefined) updates.description = input.description;
  if (input.active !== undefined) updates.active = input.active;

  // Secret: null clears, string sets, undefined leaves alone
  if (input.secret === null) {
    updates.encryptedSecret = null;
    updates.secretIv = null;
    updates.secretAuthTag = null;
  } else if (typeof input.secret === "string" && input.secret.length > 0) {
    const url = input.url ?? existing[0].url;
    const aad = Buffer.from(`webhook:${url}:secret`);
    const blob = encrypt(input.secret, aad);
    updates.encryptedSecret = blob.ciphertext;
    updates.secretIv = blob.iv;
    updates.secretAuthTag = blob.authTag;
    updates.secretAlg = blob.alg;
  }

  const [updated] = await db.update(webhooks).set(updates).where(eq(webhooks.id, id)).returning();
  return decryptWebhookRow(updated);
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
export async function signPayload(payload: string, secret: string): Promise<string> {
  const signer = new HmacSha256Signer(secret);
  const sig = await signer.sign(Buffer.from(payload));
  return sig.toString("hex");
}

const EVENT_EMOJI: Record<WebhookEvent, string> = {
  "task.completed": ":white_check_mark:",
  "task.failed": ":x:",
  "task.needs_attention": ":warning:",
  "task.pr_opened": ":rocket:",
  "review.completed": ":mag:",
  "workflow_run.queued": ":hourglass_flowing_sand:",
  "workflow_run.started": ":arrow_forward:",
  "workflow_run.completed": ":white_check_mark:",
  "workflow_run.failed": ":x:",
};

const EVENT_TEXT: Record<WebhookEvent, string> = {
  "task.completed": "Task Completed",
  "task.failed": "Task Failed",
  "task.needs_attention": "Task Needs Attention",
  "task.pr_opened": "PR Opened",
  "review.completed": "Review Completed",
  "workflow_run.queued": "Workflow Run Queued",
  "workflow_run.started": "Workflow Run Started",
  "workflow_run.completed": "Workflow Run Completed",
  "workflow_run.failed": "Workflow Run Failed",
};

/**
 * Build a Slack-compatible payload with blocks for task or workflow run details.
 */
function buildSlackPayload(
  event: WebhookEvent,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const header = `${EVENT_EMOJI[event] ?? ""} ${EVENT_TEXT[event] ?? event}`;
  const errorMessage = data.errorMessage as string | undefined;

  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: header, emoji: true },
    },
  ];

  let fallbackTitle: string;

  if (event.startsWith("workflow_run.")) {
    // Workflow run payload
    const workflowName = (data.workflowName as string) ?? "Unknown workflow";
    const runId = (data.runId as string) ?? "";
    const costUsd = data.costUsd as string | undefined;
    const durationMs = data.durationMs as number | undefined;
    const modelUsed = data.modelUsed as string | undefined;
    fallbackTitle = workflowName;

    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Workflow:*\n${workflowName}` },
        { type: "mrkdwn", text: `*Run:*\n\`${runId.slice(0, 8)}\`` },
      ],
    });

    const extras: { type: string; text: string }[] = [];
    if (modelUsed) extras.push({ type: "mrkdwn", text: `*Model:*\n${modelUsed}` });
    if (costUsd) extras.push({ type: "mrkdwn", text: `*Cost:*\n$${Number(costUsd).toFixed(2)}` });
    if (durationMs != null) {
      const sec = Math.round(durationMs / 1000);
      extras.push({ type: "mrkdwn", text: `*Duration:*\n${sec}s` });
    }
    if (extras.length > 0) {
      blocks.push({ type: "section", fields: extras });
    }
  } else {
    // Task / review payload
    const taskTitle = (data.taskTitle as string) ?? "Unknown task";
    const taskId = (data.taskId as string) ?? "";
    const repoUrl = (data.repoUrl as string) ?? "";
    const prUrl = data.prUrl as string | undefined;
    fallbackTitle = taskTitle;

    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Task:*\n${taskTitle}` },
        { type: "mrkdwn", text: `*ID:*\n\`${taskId}\`` },
      ],
    });

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
    text: `${EVENT_TEXT[event] ?? event}: ${fallbackTitle}`,
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
    headers["X-Optio-Signature"] = await signPayload(payloadStr, webhook.secret);
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
