/**
 * Repeat jobs (docs/plans/scale-out.md §2): every periodic worker registers
 * its tick as a BullMQ **job scheduler** with a stable id, so any number of
 * API instances booting in any order leave exactly one schedule per tick.
 * `upsertJobScheduler` is idempotent on the id and updates the interval
 * when the deployment's env changed it.
 *
 * Before this, every boot removed every repeatable job of every queue and
 * let the workers add theirs back — which, with more than one instance,
 * wiped the others' schedules. The one piece of that left is
 * `removeLegacyRepeatables`: a deployment that ran the old code has the old
 * `queue.add(…, { repeat })` entries (keyed by a hash) in the same sorted
 * set as the schedulers, and they would tick beside the new ones forever;
 * boot removes any entry that isn't a scheduler id we know.
 */
import type { JobsOptions, Queue } from "bullmq";
import { logger } from "../logger.js";

/**
 * Every scheduler id, by queue. The id is `<queue>.<tick>`; a queue's
 * boot-time cleanup keeps exactly these.
 */
export const REPEAT_SCHEDULERS = {
  "directory-sync": ["directory-sync.tick"],
  "trigger-delivery": ["trigger-delivery.drain"],
  "pr-watcher": ["pr-watcher.check-prs"],
  "external-pr-review": ["external-pr-review.poll-external-prs"],
  "repo-cleanup": ["repo-cleanup.health-check", "repo-cleanup.stall-check"],
  "ticket-sync": ["ticket-sync.sync"],
  "workflow-trigger-checker": ["workflow-trigger-checker.check-workflow-triggers"],
  "token-validation": ["token-validation.validate-token"],
  "reconcile-resync": ["reconcile-resync.resync"],
  "skill-sync": ["skill-sync.sync-due"],
  "config-sync": ["config-sync.sync"],
  housekeeping: ["housekeeping.sweep"],
  "local-sweep": ["local-sweep.sweep"],
  "attach-sweep": ["attach-sweep.sweep"],
} as const satisfies Record<string, readonly string[]>;

export type RepeatQueueName = keyof typeof REPEAT_SCHEDULERS;
export type RepeatSchedulerId = (typeof REPEAT_SCHEDULERS)[RepeatQueueName][number];

/** The queues that have (or had, before this module) repeat jobs. */
export const REPEAT_QUEUE_NAMES: readonly RepeatQueueName[] = Object.keys(
  REPEAT_SCHEDULERS,
) as RepeatQueueName[];

/** The job name a scheduler's ticks carry (`<queue>.<tick>` → `<tick>`). */
export function repeatJobName(id: RepeatSchedulerId): string {
  return id.slice(id.indexOf(".") + 1);
}

/**
 * Registers (or updates) the scheduler for a tick: one job named after the
 * tick every `everyMs`. Safe to call from every instance at every boot: an
 * existing scheduler with the same interval keeps its next tick. A new one
 * (or a changed interval) first ticks one interval from now, as the
 * repeatables before it did — a scheduler with `every` would otherwise
 * tick at once, beside the first passes some workers run at boot.
 */
export async function scheduleRepeat(
  queue: Queue,
  id: RepeatSchedulerId,
  everyMs: number,
  opts: Pick<JobsOptions, "removeOnComplete" | "removeOnFail"> = {},
): Promise<void> {
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error(`Invalid repeat interval for ${id}: ${everyMs}`);
  }
  try {
    await queue.upsertJobScheduler(
      id,
      { every: everyMs, startDate: Date.now() + everyMs },
      { name: repeatJobName(id), data: {}, opts },
    );
  } catch (err) {
    logger.error({ err, scheduler: id, everyMs }, "Could not register repeat job scheduler");
    throw err;
  }
}

/**
 * Removes a queue's repeat entries that are not schedulers this build
 * knows: the hash-keyed repeatables an older build registered. Idempotent,
 * and harmless to run from every instance.
 */
export async function removeLegacyRepeatables(
  queue: Queue,
  queueName: RepeatQueueName,
): Promise<number> {
  const known = new Set<string>(REPEAT_SCHEDULERS[queueName]);
  const entries = await queue.getRepeatableJobs();
  let removed = 0;
  for (const entry of entries) {
    if (known.has(entry.key)) continue;
    try {
      await queue.removeRepeatableByKey(entry.key);
      removed++;
    } catch (err) {
      logger.warn({ err, queue: queueName, key: entry.key }, "Could not remove legacy repeat job");
    }
  }
  if (removed > 0) {
    logger.info({ queue: queueName, removed }, "Removed legacy repeat jobs");
  }
  return removed;
}
