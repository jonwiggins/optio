/** Deliver queued email and chat posts with bounded retries and recover lost
 * queue jobs. Housekeeping also removes expired dead letters and sends the
 * daily digests that are due (services/notify/digest.ts). Starting the worker
 * enables durable queueing instead of immediate delivery in this process.
 */
import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";
import { runDigestTick } from "../services/notify/digest.js";
import {
  closeOutboxQueue,
  NOTIFY_OUTBOX_QUEUE,
  processOutboxRow,
  recoverOutbox,
  setOutboxActive,
} from "../services/notify/outbox.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

export const NOTIFY_HOUSEKEEPING_QUEUE = "notify-housekeeping";

/** One housekeeping pass: lost jobs back on the queue, old dead letters gone, digests out. */
export async function notifyHousekeepingTick(now = new Date()): Promise<void> {
  const recovered = await recoverOutbox(now);
  if (recovered.requeued || recovered.purged) {
    logger.info(recovered, "notify: outbox housekeeping");
  }
  const digests = await runDigestTick(now);
  if (digests.due) logger.info(digests, "notify: daily digests sent");
}

export interface NotifyWorkers {
  close(): Promise<void>;
}

export function startNotifyWorker(): NotifyWorkers {
  const bullmqOpts = getBullMQOptions();

  const delivery = new Worker(
    NOTIFY_OUTBOX_QUEUE,
    instrumentWorkerProcessor("notify-outbox", async (job) => {
      const { id } = job.data as { id: string };
      const { outcome, error } = await processOutboxRow(id);
      // BullMQ backs off and tries again; the row says how many tries are left.
      if (outcome === "retry") throw new Error(error ?? "Not delivered yet");
    }),
    { ...bullmqOpts, concurrency: 5 },
  );
  delivery.on("failed", (job, err) => {
    logger.debug({ id: job?.data?.id, err: err.message }, "notify: delivery to be retried");
  });

  const housekeepingQueue = new Queue(NOTIFY_HOUSEKEEPING_QUEUE, { ...bullmqOpts });
  const tickMs = parseIntEnv("OPTIO_NOTIFY_TICK_MS", 5 * 60_000);
  void scheduleRepeat(housekeepingQueue, "notify-housekeeping.tick", tickMs, {
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 10 },
  }).catch((err) => logger.error({ err }, "notify: could not schedule housekeeping"));
  const housekeeping = new Worker(
    NOTIFY_HOUSEKEEPING_QUEUE,
    instrumentWorkerProcessor("notify-housekeeping", async () => {
      await notifyHousekeepingTick();
    }),
    { ...bullmqOpts, concurrency: 1 },
  );
  housekeeping.on("failed", (_job, err) =>
    logger.warn({ err }, "notify: housekeeping pass failed"),
  );

  setOutboxActive(true);
  return {
    async close() {
      setOutboxActive(false);
      await delivery.close();
      await housekeeping.close();
      await housekeepingQueue.close().catch(() => undefined);
      await closeOutboxQueue();
    },
  };
}
