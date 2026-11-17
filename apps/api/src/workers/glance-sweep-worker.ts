/**
 * Fires the glance timers that are due (glance-service.ts `sweepGlanceDue`):
 * the end of a user's Watch after the quiet grace period, and the recompute
 * when a terminal's snooze ends. The timers are rows in `glance_state` with
 * a due time, so the instance that set one need not be the one that fires
 * it. The sweep is a BullMQ job scheduler with a stable id
 * (`queue.upsertJobScheduler`), so however many instances boot there is one
 * schedule and each tick runs on one worker; the sweep itself runs under the
 * `sweep:glance` lease, and the rows are claimed atomically
 * (`takeDueGlance`), so even two overlapping sweeps could not fire a timer
 * twice. A timer fires up to one interval late.
 *
 * The same tick settles chat turns orphaned by a crashed instance
 * (session-turn-service.ts `recoverSessionTurns`: `running` turns whose
 * `chat-turn:<id>` lease has lapsed), so one is settled within about a
 * lease TTL plus one interval. That step needs no lease of its own: it is
 * one idempotent UPDATE.
 */
import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";
import { sweepGlanceDue } from "../services/glance-service.js";
import { withLease } from "../services/lease-service.js";
import { recoverSessionTurns } from "../services/session-turn-service.js";
import { getBullMQOptions } from "../services/redis-config.js";

export const GLANCE_SWEEP_QUEUE = "glance-sweep";
export const GLANCE_SWEEP_SCHEDULER_ID = "glance-sweep";
export const GLANCE_SWEEP_LEASE = "sweep:glance";

/** One sweep under the lease; `null` when another instance holds it. */
async function runGlanceSweep(intervalMs: number): Promise<number | null> {
  return withLease(GLANCE_SWEEP_LEASE, () => sweepGlanceDue(), {
    ttlMs: Math.max(5_000, intervalMs),
  });
}

export function startGlanceSweepWorker(): { close(): Promise<void> } {
  const intervalMs = parseIntEnv("OPTIO_GLANCE_SWEEP_INTERVAL", 30_000);
  const bullmqOpts = getBullMQOptions();
  const queue = new Queue(GLANCE_SWEEP_QUEUE, { ...bullmqOpts });
  queue
    .upsertJobScheduler(
      GLANCE_SWEEP_SCHEDULER_ID,
      { every: intervalMs },
      {
        name: "sweep",
        opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
      },
    )
    .catch((err) => logger.error({ err }, "glance sweep: could not schedule"));

  const worker = new Worker(
    GLANCE_SWEEP_QUEUE,
    async () => {
      await runGlanceSweep(intervalMs).catch((err) => logger.warn({ err }, "glance sweep failed"));
      await recoverSessionTurns().catch((err) => logger.warn({ err }, "chat turn recovery failed"));
    },
    { ...bullmqOpts, concurrency: 1 },
  );
  worker.on("failed", (_job, err) => logger.warn({ err }, "glance sweep failed"));

  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
