import { underPollerLease } from "../services/poller-lease.js";
import { Queue, Worker } from "bullmq";
import { getBullMQOptions } from "../services/redis-config.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";
import { drainTriggerDeliveries, pruneTriggerDeliveries } from "../services/trigger-delivery.js";
import { logger } from "../logger.js";

const options = getBullMQOptions();
const triggerDeliveryQueue = new Queue("trigger-delivery", options);
export function startDeliveryWorker() {
  void scheduleRepeat(triggerDeliveryQueue, "trigger-delivery.drain", 1000, {
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 10 },
  }).catch((err) => logger.error({ err }, "Failed to schedule trigger delivery"));
  let nextPrune = 0;
  const worker = new Worker(
    "trigger-delivery",
    async () => {
      await drainTriggerDeliveries();
      if (Date.now() >= nextPrune) {
        await underPollerLease("trigger-delivery-prune", pruneTriggerDeliveries);
        nextPrune = Date.now() + 3_600_000;
      }
    },
    { ...options, concurrency: 1 },
  );
  worker.on("failed", (_job, err) => logger.error({ err }, "Trigger delivery worker failed"));
  return worker;
}
