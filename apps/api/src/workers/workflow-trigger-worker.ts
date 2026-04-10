import { Queue, Worker } from "bullmq";
import * as workflowService from "../services/workflow-service.js";
import { logger } from "../logger.js";
import { getBullMQConnectionOptions } from "../services/redis-config.js";

const connectionOpts = getBullMQConnectionOptions();

export const workflowTriggerQueue = new Queue("workflow-trigger-checker", {
  connection: connectionOpts,
});

export function startWorkflowTriggerWorker() {
  workflowTriggerQueue.add(
    "check-workflow-triggers",
    {},
    {
      repeat: {
        every: parseInt(process.env.OPTIO_WORKFLOW_TRIGGER_INTERVAL ?? "60000", 10),
      },
    },
  );

  const worker = new Worker(
    "workflow-trigger-checker",
    async () => {
      const dueRows = await workflowService.getDueScheduleTriggers();
      if (dueRows.length === 0) return;

      logger.info({ count: dueRows.length }, "Processing due workflow schedule triggers");

      for (const { trigger, workflow } of dueRows) {
        const config = trigger.config as Record<string, unknown> | null;
        const cronExpression = config?.cronExpression as string | undefined;

        if (!cronExpression) {
          logger.warn(
            { triggerId: trigger.id, workflowId: workflow.id },
            "Schedule trigger missing cronExpression in config, skipping",
          );
          continue;
        }

        try {
          const run = await workflowService.createWorkflowRun(workflow.id, {
            triggerId: trigger.id,
            params: trigger.paramMapping as Record<string, unknown> | undefined,
          });

          await workflowService.markTriggerFired(trigger.id, cronExpression);

          logger.info(
            {
              triggerId: trigger.id,
              workflowId: workflow.id,
              workflowRunId: run.id,
              workflowName: workflow.name,
            },
            "Workflow schedule trigger fired",
          );
        } catch (err) {
          // Still advance nextFireAt so we don't re-fire on the same tick
          try {
            await workflowService.markTriggerFired(trigger.id, cronExpression);
          } catch {
            // best-effort
          }
          logger.error(
            { err, triggerId: trigger.id, workflowId: workflow.id },
            "Failed to fire workflow schedule trigger",
          );
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
