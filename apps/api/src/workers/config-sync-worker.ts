/**
 * Reads the configuration directory (`OPTIO_CONFIG_DIR`) every interval and
 * applies it — services/config/source.ts. The apply is idempotent (rows that
 * already match aren't written), so a tick with no changes costs a few
 * queries; a tick after someone edited a managed row in the UI puts the
 * file's version back. Only started when the directory is configured; the
 * first pass runs at once so a fresh deployment comes up with its config.
 */
import { Queue, Worker } from "bullmq";
import { logger } from "../logger.js";
import { getBullMQConnectionOptions } from "../services/redis-config.js";
import { envConfigSource, syncEnvSource } from "../services/config/source.js";

const QUEUE = "config-sync";

export function startConfigSyncWorker(): Worker | null {
  const env = envConfigSource();
  if (!env) return null;
  const connection = getBullMQConnectionOptions();
  const queue = new Queue(QUEUE, { connection });
  queue
    .add(
      "sync",
      {},
      {
        repeat: { every: env.intervalMs },
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 20 },
      },
    )
    .catch((err) => logger.error({ err }, "config sync: could not schedule"));

  const worker = new Worker(
    QUEUE,
    async () => {
      await syncEnvSource();
    },
    { connection, concurrency: 1 },
  );
  worker.on("failed", (_job, err) => logger.error({ err }, "config sync failed"));

  // Don't wait a whole interval for the first pass.
  syncEnvSource().catch((err) => logger.error({ err }, "config sync: first pass failed"));
  logger.info(
    { dir: env.dir, everyMs: env.intervalMs, prune: env.prune },
    "Config sync worker started",
  );
  return worker;
}
