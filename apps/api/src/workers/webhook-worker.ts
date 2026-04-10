import { Queue, Worker } from "bullmq";
import { logger } from "../logger.js";
import {
  getWebhooksForEvent,
  deliverWebhook,
  getWebhook,
  type WebhookEvent,
} from "../services/webhook-service.js";
import { recordWebhookDelivery } from "../telemetry/metrics.js";
import { emitWebhookDeliveryFailureLog } from "../telemetry/logs.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";
import { injectTraceContextIntoJob } from "../telemetry/spans.js";

import { getBullMQConnectionOptions } from "../services/redis-config.js";

const webhookQueue = new Queue("webhooks", { connection: getBullMQConnectionOptions() });

/**
 * Enqueue a webhook delivery job for all active webhooks that subscribe to the event.
 */
export async function enqueueWebhookEvent(event: WebhookEvent, data: Record<string, unknown>) {
  const matchingWebhooks = await getWebhooksForEvent(event);
  if (matchingWebhooks.length === 0) return;

  for (const webhook of matchingWebhooks) {
    await webhookQueue.add(
      "deliver",
      injectTraceContextIntoJob({ webhookId: webhook.id, event, data }),
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 }, // 5s, 10s, 20s
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 500 },
      },
    );
  }

  logger.info({ event, webhookCount: matchingWebhooks.length }, "Enqueued webhook deliveries");
}

/**
 * Start the BullMQ worker that processes webhook delivery jobs.
 */
export function startWebhookWorker() {
  const worker = new Worker(
    "webhooks",
    instrumentWorkerProcessor("webhook-worker", async (job) => {
      const { webhookId, event, data } = job.data as {
        webhookId: string;
        event: WebhookEvent;
        data: Record<string, unknown>;
      };

      const webhook = await getWebhook(webhookId);
      if (!webhook || !webhook.active) {
        logger.info({ webhookId }, "Webhook not found or inactive, skipping delivery");
        return;
      }

      const attempt = (job.attemptsMade ?? 0) + 1;
      const delivery = await deliverWebhook(webhook, event, data, attempt);

      if (!delivery.success) {
        recordWebhookDelivery(event, false);
        emitWebhookDeliveryFailureLog(webhookId, event, delivery.statusCode ?? 0);
        throw new Error(delivery.error ?? `Delivery failed with status ${delivery.statusCode}`);
      }

      recordWebhookDelivery(event, true);
      logger.info(
        { webhookId, event, statusCode: delivery.statusCode },
        "Webhook delivered successfully",
      );
    }),
    {
      connection: getBullMQConnectionOptions(),
      concurrency: 10,
    },
  );

  worker.on("failed", (job, err) => {
    logger.warn(
      { jobId: job?.id, webhookId: job?.data?.webhookId, err: err.message },
      "Webhook delivery job failed",
    );
  });

  return worker;
}
