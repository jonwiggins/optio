/**
 * Optio Local liveness sweep, every `OPTIO_LOCAL_SWEEP_INTERVAL` (30 s):
 * marks hosts offline whose daemon stopped pinging or whose owning instance
 * went away (its `local-host:<id>` lease lapsed), starts terminals parked as
 * host-offline whose host is back, and fails `launching` terminals an online
 * daemon never acknowledged. A BullMQ job scheduler with a stable id
 * (`local-sweep.sweep`), so however many API instances boot there is one
 * schedule, and each tick runs under the `poller:local-sweep` lease; every
 * step is a guarded UPDATE or a CAS, safe even if two overlapped.
 */
import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";
import { sweepStaleHosts, sweepUnownedHosts } from "../services/local-host-service.js";
import {
  flushParkedForOnlineHosts,
  sweepStuckLaunching,
} from "../services/local-terminal-service.js";
import { underPollerLease } from "../services/poller-lease.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";

const STEPS: Array<[string, () => Promise<unknown>]> = [
  ["stale hosts", sweepStaleHosts],
  ["unowned hosts", sweepUnownedHosts],
  ["parked terminals", flushParkedForOnlineHosts],
  ["stuck launches", sweepStuckLaunching],
];

/** One sweep (the tick's body; exported for tests). Each step's failure is its own. */
async function runLocalSweep(): Promise<void> {
  for (const [name, step] of STEPS) {
    try {
      await step();
    } catch (err) {
      logger.warn({ err, step: name }, "local sweep step failed");
    }
  }
}

export function startLocalSweepWorker(): { close(): Promise<void> } {
  const intervalMs = parseIntEnv("OPTIO_LOCAL_SWEEP_INTERVAL", 30_000);
  const bullmqOpts = getBullMQOptions();
  const queue = new Queue("local-sweep", { ...bullmqOpts });
  void scheduleRepeat(queue, "local-sweep.sweep", intervalMs, {
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 20 },
  }).catch(() => {});

  const worker = new Worker(
    "local-sweep",
    async () => {
      await underPollerLease("local-sweep", () => runLocalSweep());
    },
    { ...bullmqOpts, concurrency: 1 },
  );
  worker.on("failed", (_job, err) => logger.warn({ err }, "local sweep failed"));

  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
