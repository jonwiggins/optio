/**
 * The attach sweep (docs/plans/scale-out.md §2): every 30 s, every run
 * whose attachment expired — the instance that held it went away, or gave
 * it up at shutdown — gets a reconcile pass, whose `reattach` decision
 * hands the run to an instance that is up. Without this a lost run would
 * wait for the 5-minute resync.
 *
 * The sweep only enqueues reconcile keys, which the reconciler dedupes by
 * its CAS, so every instance running it at once costs a few redundant
 * passes and nothing else.
 */
import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import { and, inArray, isNull, lt, or, sql, type AnyColumn } from "drizzle-orm";
import { db } from "../db/client.js";
import { persistentAgentTurns, prReviewRuns, workRuns } from "../db/schema.js";
import { enqueueReconcile } from "../services/reconcile-queue.js";
import { ATTACH_LEASE_MS } from "../services/run-attachment.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";
import { logger } from "../logger.js";

const bullmqOpts = getBullMQOptions();

const ATTACH_SWEEP_QUEUE = "attach-sweep";
/** Every 30 s (docs/plans/scale-out.md §2); quicker in the scale-out e2e tier. */
const ATTACH_SWEEP_INTERVAL_MS = parseIntEnv("OPTIO_ATTACH_SWEEP_INTERVAL_MS", 30_000);

const attachSweepQueue = new Queue(ATTACH_SWEEP_QUEUE, { ...bullmqOpts });

/** The attachment is gone: its lease passed, or it never got one and the row is old. */
function expired(lease: AnyColumn, age: AnyColumn) {
  return or(
    lt(lease, sql`now()`),
    and(
      isNull(lease),
      lt(age, sql`now() - make_interval(secs => ${(2 * ATTACH_LEASE_MS) / 1000})`),
    ),
  );
}

/** Enqueues a reconcile pass for every active pod run whose attachment expired. */
export async function sweepExpiredAttachments(): Promise<number> {
  let count = 0;

  const runs = await db
    .select({ id: workRuns.id, kind: workRuns.kind })
    .from(workRuns)
    .where(
      and(
        inArray(workRuns.state, ["provisioning", "running"]),
        isNull(workRuns.localTerminalId),
        expired(workRuns.attachLeaseUntil, workRuns.updatedAt),
      ),
    );
  for (const run of runs) {
    await enqueueReconcile(
      { kind: run.kind === "standalone" ? "standalone" : "repo", id: run.id },
      { reason: "attachment_expired" },
    );
    count++;
  }

  const reviewRuns = await db
    .select({ prReviewId: prReviewRuns.prReviewId })
    .from(prReviewRuns)
    .where(
      and(
        inArray(prReviewRuns.state, ["provisioning", "running"]),
        expired(prReviewRuns.attachLeaseUntil, prReviewRuns.updatedAt),
      ),
    );
  for (const run of reviewRuns) {
    await enqueueReconcile(
      { kind: "pr-review", id: run.prReviewId },
      { reason: "attachment_expired" },
    );
    count++;
  }

  const turns = await db
    .select({ agentId: persistentAgentTurns.agentId })
    .from(persistentAgentTurns)
    .where(
      and(
        isNull(persistentAgentTurns.finishedAt),
        expired(persistentAgentTurns.attachLeaseUntil, persistentAgentTurns.createdAt),
      ),
    );
  for (const turn of turns) {
    await enqueueReconcile(
      { kind: "persistent-agent", id: turn.agentId },
      { reason: "attachment_expired" },
    );
    count++;
  }

  if (count > 0) logger.info({ count }, "Attachment sweep: runs handed to the reconciler");
  return count;
}

export function startAttachSweepWorker(): Worker {
  // One scheduler, the same on every instance: upserting it is idempotent
  // (services/repeat-jobs.ts lists it, so boot's cleanup keeps it).
  void scheduleRepeat(attachSweepQueue, "attach-sweep.sweep", ATTACH_SWEEP_INTERVAL_MS, {
    removeOnComplete: 20,
    removeOnFail: 20,
  }).catch((err) => logger.warn({ err }, "Failed to schedule the attachment sweep"));

  const worker = new Worker(
    ATTACH_SWEEP_QUEUE,
    instrumentWorkerProcessor("attach-sweep", async () => {
      await sweepExpiredAttachments();
    }),
    { ...bullmqOpts, concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    logger.warn({ jobId: job?.id, err }, "Attachment sweep failed");
  });
  return worker;
}
