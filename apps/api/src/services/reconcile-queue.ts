import { Queue } from "bullmq";
import { runKey } from "@optio/shared";
import type { RunRef } from "@optio/shared";
import { getBullMQOptions } from "./redis-config.js";
import { logger } from "../logger.js";

const bullmqOpts = getBullMQOptions();

export const RECONCILE_QUEUE_NAME = "reconcile";

export const reconcileQueue = new Queue(RECONCILE_QUEUE_NAME, {
  ...bullmqOpts,
});

export interface EnqueueOptions {
  /** Reason string for telemetry. Not used for dedup. */
  reason: string;
  /** Optional delay before the reconcile tick runs. */
  delayMs?: number;
}

/**
 * Enqueue a reconcile pass for the given run.
 *
 * Each call creates a fresh BullMQ job (jobId is timestamp-suffixed). We
 * cannot use a stable jobId for dedup: BullMQ's `queue.add()` is a no-op
 * when the same jobId exists in *any* state — including `completed` — so
 * once a reconcile completes for a given run, a stable jobId would silently
 * block all future enqueues for that run until the completed entry is
 * evicted. The reconciler's executor is CAS-gated and idempotent, so a few
 * back-to-back redundant passes from rapid transitions cost ~ms each.
 */
export async function enqueueReconcile(ref: RunRef, opts: EnqueueOptions): Promise<void> {
  const baseId = runKey(ref);
  try {
    await reconcileQueue.add(
      "reconcile",
      { ref, reason: opts.reason },
      {
        jobId: `${baseId}__${Date.now()}__${Math.floor(Math.random() * 1000)}`,
        delay: opts.delayMs,
        removeOnComplete: 1000,
        removeOnFail: 500,
      },
    );
  } catch (err) {
    logger.warn({ err, ref, reason: opts.reason }, "enqueueReconcile failed");
  }
}
