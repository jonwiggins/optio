import { Queue, Worker } from "bullmq";
import * as workflowService from "../services/workflow-service.js";
import * as taskConfigService from "../services/task-config-service.js";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";
import { getBullMQConnectionOptions } from "../services/redis-config.js";

const connectionOpts = getBullMQConnectionOptions();

export const workflowTriggerQueue = new Queue("workflow-trigger-checker", {
  connection: connectionOpts,
});

/**
 * Polls for due schedule triggers and dispatches to the trigger's target.
 * Supports multiple target_type values — currently "job" (workflow run);
 * "task_config" wiring is added in a follow-up once that target exists.
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
      const triggers = await workflowService.getDueScheduleTriggersAll();
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
          await dispatchTrigger(trigger);
          await workflowService.markTriggerFired(trigger.id, cronExpression);
        } catch (err) {
          // Still advance nextFireAt so we don't re-fire on the same tick.
          try {
            await workflowService.markTriggerFired(trigger.id, cronExpression);
          } catch {
            // best-effort
          }
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
      }
    },
    { connection: connectionOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "Workflow trigger checker failed");
  });

  return worker;
}

async function dispatchTrigger(trigger: {
  id: string;
  targetType: string;
  targetId: string;
  paramMapping: Record<string, unknown> | null;
}) {
  if (trigger.targetType === "job") {
    const workflow = await workflowService.getWorkflow(trigger.targetId);
    if (!workflow) {
      logger.warn(
        { triggerId: trigger.id, workflowId: trigger.targetId },
        "Schedule trigger references missing workflow, skipping",
      );
      return;
    }
    if (!workflow.enabled) {
      logger.debug(
        { triggerId: trigger.id, workflowId: workflow.id },
        "Schedule trigger target workflow is disabled, skipping",
      );
      return;
    }
    const run = await workflowService.createWorkflowRun(workflow.id, {
      triggerId: trigger.id,
      params: trigger.paramMapping ?? undefined,
    });
    logger.info(
      {
        triggerId: trigger.id,
        workflowId: workflow.id,
        workflowRunId: run.id,
        workflowName: workflow.name,
      },
      "Workflow schedule trigger fired",
    );
    return;
  }

  if (trigger.targetType === "task_config") {
    const taskConfig = await taskConfigService.getTaskConfig(trigger.targetId);
    if (!taskConfig) {
      logger.warn(
        { triggerId: trigger.id, taskConfigId: trigger.targetId },
        "Schedule trigger references missing task_config, skipping",
      );
      return;
    }
    if (!taskConfig.enabled) {
      logger.debug(
        { triggerId: trigger.id, taskConfigId: taskConfig.id },
        "Schedule trigger target task_config is disabled, skipping",
      );
      return;
    }
    const task = await taskConfigService.instantiateTask(taskConfig.id, {
      triggerId: trigger.id,
      params: trigger.paramMapping ?? undefined,
    });
    logger.info(
      {
        triggerId: trigger.id,
        taskConfigId: taskConfig.id,
        taskId: task.id,
        taskConfigName: taskConfig.name,
      },
      "Task config schedule trigger fired",
    );
    return;
  }

  if (trigger.targetType === "persistent_agent") {
    const { getPersistentAgent, wakeAgent, buildSenderId } =
      await import("../services/persistent-agent-service.js");
    const agent = await getPersistentAgent(trigger.targetId);
    if (!agent) {
      logger.warn(
        { triggerId: trigger.id, agentId: trigger.targetId },
        "Schedule trigger references missing persistent agent, skipping",
      );
      return;
    }
    if (!agent.enabled) {
      logger.debug(
        { triggerId: trigger.id, agentId: agent.id },
        "Schedule trigger target persistent agent is disabled, skipping",
      );
      return;
    }
    // Render the trigger payload as a system message into the agent's inbox.
    // The reconciler picks it up and starts a turn.
    const body =
      trigger.paramMapping && Object.keys(trigger.paramMapping).length > 0
        ? `Scheduled tick (trigger ${trigger.id}). Payload:\n${JSON.stringify(trigger.paramMapping, null, 2)}`
        : `Scheduled tick (trigger ${trigger.id}).`;
    await wakeAgent({
      agentId: agent.id,
      source: "schedule",
      body,
      senderType: "system",
      senderId: buildSenderId({ type: "system", label: "scheduler" }),
      senderName: "Scheduler",
      structuredPayload: trigger.paramMapping ?? undefined,
    });
    logger.info(
      { triggerId: trigger.id, agentId: agent.id, slug: agent.slug },
      "Persistent agent schedule trigger fired",
    );
    return;
  }

  if (trigger.targetType === "pr_review") {
    // Target id is a pr_reviews.id — fire a rereview.
    const { reReview } = await import("../services/pr-review-service.js");
    try {
      const result = await reReview(trigger.targetId);
      logger.info(
        {
          triggerId: trigger.id,
          prReviewId: result.review.id,
          runId: result.run.id,
        },
        "PR review schedule trigger fired",
      );
    } catch (err) {
      logger.warn(
        { err, triggerId: trigger.id, prReviewId: trigger.targetId },
        "PR review schedule trigger failed",
      );
    }
    return;
  }

  logger.warn(
    { triggerId: trigger.id, targetType: trigger.targetType },
    "Unknown trigger target_type, skipping",
  );
}
