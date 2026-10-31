/**
 * The directory sync's clock (services/directory-sync.ts,
 * docs/directory-sync.md). A short tick, every five minutes on whichever
 * instance BullMQ hands it to, asks whether a run is due — the sync is on,
 * LDAP sign-in is set up, and the interval (Settings → Access → Directory
 * sync, 15 minutes to a day) has passed since the last run
 * started — so a changed interval holds at once without rescheduling
 * anything. The run itself takes the `directory-sync` lease: one at a time
 * across every API instance, a "Run now" included.
 */
import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";
import { runDirectorySyncIfDue } from "../services/directory-sync.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";

const QUEUE = "directory-sync";

export function startDirectorySyncWorker(): Worker {
  const bullmqOpts = getBullMQOptions();
  const queue = new Queue(QUEUE, { ...bullmqOpts });
  const tickMs = parseIntEnv("OPTIO_DIRECTORY_SYNC_TICK_MS", 5 * 60_000);
  void scheduleRepeat(queue, "directory-sync.tick", tickMs, {
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 10 },
  }).catch((err) => logger.error({ err }, "directory sync: could not schedule"));

  const worker = new Worker(
    QUEUE,
    async () => {
      const outcome = await runDirectorySyncIfDue();
      if (outcome === "ran") logger.debug("directory sync: scheduled run done");
    },
    { ...bullmqOpts, concurrency: 1 },
  );
  worker.on("failed", (_job, err) => logger.error({ err }, "directory sync tick failed"));
  return worker;
}
