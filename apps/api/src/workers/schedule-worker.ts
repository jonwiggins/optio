import { Queue, Worker } from "bullmq";
import { TaskState } from "@optio/shared";
import * as scheduleService from "../services/schedule-service.js";
import * as taskService from "../services/task-service.js";
import { taskQueue } from "./task-worker.js";
import { logger } from "../logger.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";
import { injectTraceContextIntoJob } from "../telemetry/spans.js";

import { getBullMQConnectionOptions } from "../services/redis-config.js";

const connectionOpts = getBullMQConnectionOptions();

export const scheduleCheckerQueue = new Queue("schedule-checker", { connection: connectionOpts });

export function startScheduleWorker() {
  scheduleCheckerQueue.add(
    "check-schedules",
    {},
    {
      repeat: {
        every: parseInt(process.env.OPTIO_SCHEDULE_CHECK_INTERVAL ?? "60000", 10),
      },
    },
  );

  const worker = new Worker(
    "schedule-checker",
    instrumentWorkerProcessor("schedule-worker", async () => {
      const dueSchedules = await scheduleService.getDueSchedules();
      if (dueSchedules.length === 0) return;

      logger.info({ count: dueSchedules.length }, "Processing due schedules");

      for (const schedule of dueSchedules) {
        const config = schedule.taskConfig as {
          title: string;
          prompt: string;
          repoUrl: string;
          repoBranch?: string;
          agentType: string;
          maxRetries?: number;
          priority?: number;
        };

        try {
          const task = await taskService.createTask({
            title: config.title,
            prompt: config.prompt,
            repoUrl: config.repoUrl,
            repoBranch: config.repoBranch,
            agentType: config.agentType,
            maxRetries: config.maxRetries,
            priority: config.priority,
            metadata: { scheduleId: schedule.id, scheduleName: schedule.name },
          });

          await taskService.transitionTask(task.id, TaskState.QUEUED, "schedule_trigger");
          await taskQueue.add("process-task", injectTraceContextIntoJob({ taskId: task.id }), {
            jobId: task.id,
            priority: task.priority ?? 100,
            attempts: task.maxRetries + 1,
            backoff: { type: "exponential", delay: 5000 },
          });

          await scheduleService.recordRun(schedule.id, task.id, "created");
          await scheduleService.markScheduleRan(schedule.id, schedule.cronExpression);

          logger.info(
            { scheduleId: schedule.id, taskId: task.id, scheduleName: schedule.name },
            "Schedule triggered task",
          );
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "Unknown error";
          await scheduleService.recordRun(schedule.id, null, "failed", errorMsg);
          await scheduleService.markScheduleRan(schedule.id, schedule.cronExpression);
          logger.error(
            { err, scheduleId: schedule.id, scheduleName: schedule.name },
            "Failed to trigger scheduled task",
          );
        }
      }
    }),
    { connection: connectionOpts, concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "Schedule checker failed");
  });

  return worker;
}
