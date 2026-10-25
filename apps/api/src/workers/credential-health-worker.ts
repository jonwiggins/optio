/**
 * The credential-health tick (docs/credential-health.md): every N minutes
 * (`OPTIO_CREDENTIAL_HEALTH_INTERVAL_MINUTES`, chart
 * `credentialHealth.intervalMinutes`; unset or 0: off, and "Check now" on
 * Settings → System health still checks on demand) one API instance —
 * the one holding the `poller:credential-health` lease — checks every token
 * Optio holds and warns the owners (services/credential-health.ts). A first
 * pass runs a minute after boot, so the System health page isn't empty for
 * a quarter of an hour on a fresh install.
 */
import { Queue, Worker } from "bullmq";
import { logger } from "../logger.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";
import { credentialHealthTick } from "../services/credential-health.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

const bullmqOpts = getBullMQOptions();

export const CREDENTIAL_HEALTH_QUEUE = "credential-health";

export const credentialHealthQueue = new Queue(CREDENTIAL_HEALTH_QUEUE, { ...bullmqOpts });

/** Minutes between passes; 0 (or less) = no periodic checks. */
export function credentialHealthIntervalMs(): number {
  const raw = process.env.OPTIO_CREDENTIAL_HEALTH_INTERVAL_MINUTES;
  const minutes = raw === undefined || raw.trim() === "" ? 0 : Number(raw);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : 0;
}

export function startCredentialHealthWorker(): Worker | null {
  const everyMs = credentialHealthIntervalMs();
  if (!everyMs) {
    logger.info(
      "Periodic credential health checks are off (OPTIO_CREDENTIAL_HEALTH_INTERVAL_MINUTES unset or 0)",
    );
    // A schedule an earlier boot left would queue ticks nobody takes.
    void credentialHealthQueue.removeJobScheduler("credential-health.check").catch(() => undefined);
    return null;
  }
  void scheduleRepeat(credentialHealthQueue, "credential-health.check", everyMs, {
    removeOnComplete: 20,
    removeOnFail: 20,
  }).catch((err) => logger.warn({ err }, "Failed to schedule the credential health checks"));

  const worker = new Worker(
    CREDENTIAL_HEALTH_QUEUE,
    instrumentWorkerProcessor("credential-health", async () => {
      await credentialHealthTick();
    }),
    { ...bullmqOpts, concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    logger.warn({ jobId: job?.id, err }, "Credential health pass failed");
  });

  const first = setTimeout(() => {
    credentialHealthTick().catch((err) =>
      logger.warn({ err }, "First credential health pass failed"),
    );
  }, 60_000);
  first.unref?.();
  worker.on("closing", () => clearTimeout(first));
  return worker;
}
