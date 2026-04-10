import { Queue, Worker } from "bullmq";
import { logger } from "../logger.js";
import { getBullMQConnectionOptions } from "../services/redis-config.js";

const connectionOpts = getBullMQConnectionOptions();

export const workflowRunQueue = new Queue("workflow-runs", { connection: connectionOpts });

/**
 * Process workflow-run jobs.
 * - "start-run": kicks off execution of a queued workflow run
 */
export function startWorkflowRunWorker() {
  const worker = new Worker(
    "workflow-runs",
    async (job) => {
      const { workflowRunId } = job.data as { workflowRunId: string };
      logger.info({ workflowRunId, jobName: job.name }, "Processing workflow run job");
    },
    { connection: connectionOpts, concurrency: 5 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "Workflow run worker failed");
  });

  return worker;
}
