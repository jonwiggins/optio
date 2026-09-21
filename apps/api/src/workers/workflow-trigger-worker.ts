import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";
import { getBullMQConnectionOptions } from "../services/redis-config.js";
import { advanceSchedule, listDueScheduleTriggers } from "../services/trigger-service.js";
import { fireTrigger } from "../services/trigger-dispatch.js";

const connectionOpts = getBullMQConnectionOptions();

export const workflowTriggerQueue = new Queue("workflow-trigger-checker", {
  connection: connectionOpts,
});

/**
 * Polls for due schedule triggers and hands each to the trigger dispatcher,
 * which starts whatever the trigger targets (a Job run, a Task, a Local
 * terminal, an agent turn, a re-review). The schedule is advanced whether
 * or not the dispatch succeeded, so one broken target can't re-fire every
 * tick.
 */
export function startWorkflowTriggerWorker() {
  workflowTriggerQueue.add(
    "check-workflow-triggers",
    {},
    {
      repeat: {
        every: parseIntEnv("OPTIO_WORKFLOW_TRIGGER_INTERVAL", 60000),
      },
    },
  );

  const worker = new Worker(
    "workflow-trigger-checker",
    async () => {
      const triggers = await listDueScheduleTriggers();
      if (triggers.length === 0) return;

      logger.info({ count: triggers.length }, "Processing due schedule triggers");

      for (const trigger of triggers) {
        const config = trigger.config as Record<string, unknown> | null;
        const cronExpression = config?.cronExpression as string | undefined;

        if (!cronExpression) {
          logger.warn(
            { triggerId: trigger.id, targetType: trigger.targetType, targetId: trigger.targetId },
            "Schedule trigger missing cronExpression in config, skipping",
          );
          continue;
        }

        try {
          await fireTrigger(trigger, {
            source: "schedule",
            params: trigger.paramMapping ?? undefined,
          });
        } catch (err) {
          logger.error(
            {
              err,
              triggerId: trigger.id,
              targetType: trigger.targetType,
              targetId: trigger.targetId,
            },
            "Failed to fire schedule trigger",
          );
        }
        try {
          await advanceSchedule(trigger.id, cronExpression);
        } catch {
          // best-effort
        }
      }
    },
    { connection: connectionOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "Workflow trigger checker failed");
  });

  return worker;
}
