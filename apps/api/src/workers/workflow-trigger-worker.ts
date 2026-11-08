import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { advanceScheduleCas, listDueScheduleTriggers } from "../services/trigger-service.js";
import { db } from "../db/client.js";
import { enqueueOccurrence, drainTriggerDeliveries } from "../services/trigger-delivery.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";
import { underPollerLease } from "../services/poller-lease.js";

const bullmqOpts = getBullMQOptions();

export const workflowTriggerQueue = new Queue("workflow-trigger-checker", {
  ...bullmqOpts,
});

/** Advances each due schedule and saves its occurrence in one transaction.
 * The delivery worker starts that occurrence using its fixed run identity;
 * transient dispatch failures never consume the schedule without durable work.
 */
export function startWorkflowTriggerWorker() {
  void scheduleRepeat(
    workflowTriggerQueue,
    "workflow-trigger-checker.check-workflow-triggers",
    parseIntEnv("OPTIO_WORKFLOW_TRIGGER_INTERVAL", 60000),
  ).catch(() => {});

  const worker = new Worker(
    "workflow-trigger-checker",
    async () => {
      await underPollerLease("workflow-trigger-checker", () => checkDueScheduleTriggers());
    },
    { ...bullmqOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "Workflow trigger checker failed");
  });

  return worker;
}

/** One sweep: fires every due schedule trigger it manages to advance first. Returns how many fired. */
export async function checkDueScheduleTriggers(): Promise<number> {
  const triggers = await listDueScheduleTriggers();
  if (triggers.length === 0) return 0;

  logger.info({ count: triggers.length }, "Processing due schedule triggers");

  let fired = 0;
  for (const trigger of triggers) {
    const config = trigger.config;
    const cronExpression = config?.cronExpression as string | undefined;

    if (!cronExpression) {
      logger.warn(
        { triggerId: trigger.id, targetType: trigger.targetType, targetId: trigger.targetId },
        "Schedule trigger missing cronExpression in config, skipping",
      );
      continue;
    }

    // Advance first: the firing belongs to whoever moved the schedule off
    // the tick the sweep saw. A sweep that lost the race skips the trigger.
    let advanced = false;
    try {
      advanced = await db.transaction(async (tx) => {
        const won = await advanceScheduleCas(
          trigger.id,
          cronExpression,
          trigger.nextFireAt,
          tx,
          config?.timezone as string | undefined,
        );
        if (won)
          await enqueueOccurrence(
            trigger,
            { source: "schedule", params: trigger.paramMapping ?? undefined },
            `schedule:${trigger.id}:${trigger.nextFireAt!.toISOString()}`,
            tx,
          );
        return won;
      });
    } catch (err) {
      logger.error({ err, triggerId: trigger.id }, "Failed to advance schedule trigger");
      continue;
    }
    if (!advanced) {
      logger.debug({ triggerId: trigger.id }, "Schedule trigger already fired by another sweep");
      continue;
    }

    fired++;
  }
  await drainTriggerDeliveries();
  return fired;
}
