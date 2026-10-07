import { Queue, Worker } from "bullmq";
import {
  parseIntEnv,
  reconcileRepo,
  reconcileStandalone,
  reconcilePrReview,
  reconcilePersistentAgent,
} from "@optio/shared";
import type { RunRef, Action } from "@optio/shared";
import { getBullMQOptions } from "../services/redis-config.js";
import { buildWorldSnapshot } from "../services/reconcile-snapshot.js";
import { executeAction, type ExecuteOutcome } from "../services/reconcile-executor.js";
import { reconcileQueue, enqueueReconcile } from "../services/reconcile-queue.js";
import { logger } from "../logger.js";
import { instrumentWorkerProcessor } from "../telemetry/instrument-worker.js";

const bullmqOpts = getBullMQOptions();

/**
 * The reconcile worker pops keys off the `reconcile` queue, builds a fresh
 * WorldSnapshot for each, runs the pure decision function, and executes the
 * resulting action via the CAS-gated executor.
 */
export function startReconcileWorker() {
  const concurrency = parseIntEnv("OPTIO_RECONCILE_CONCURRENCY", 4);

  logger.info({ concurrency }, "Starting reconcile worker");

  const worker = new Worker(
    "reconcile",
    instrumentWorkerProcessor("reconcile-worker", async (job) => {
      const { ref, reason } = job.data as { ref: RunRef; reason: string };
      const log = logger.child({ ref, reason });

      const snapshot = await buildWorldSnapshot(ref);
      if (!snapshot) {
        log.debug("Run not found; dropping reconcile job");
        return;
      }

      const action: Action =
        snapshot.run.kind === "repo"
          ? reconcileRepo(snapshot)
          : snapshot.run.kind === "pr-review"
            ? reconcilePrReview(snapshot)
            : snapshot.run.kind === "persistent-agent"
              ? reconcilePersistentAgent(snapshot)
              : reconcileStandalone(snapshot);

      const outcome: ExecuteOutcome = await executeAction(action, snapshot);

      log.info(
        {
          decision: action.kind,
          decisionReason: action.reason,
          outcome: outcome.status,
          outcomeReason: outcome.reason,
        },
        "reconcile.decision",
      );

      // Requeue-soon actions re-enqueue themselves with a delay so the
      // reconciler can try again when capacity frees up.
      if (action.kind === "requeueSoon") {
        await enqueueReconcile(ref, {
          reason: `requeue_soon:${action.reason}`,
          delayMs: action.delayMs,
        });
      }

      // Stale outcomes re-enqueue immediately with a small delay so another
      // worker (or this one) re-reads truth.
      if (outcome.status === "stale") {
        await enqueueReconcile(ref, {
          reason: `stale_retry:${outcome.reason}`,
          delayMs: 500 + Math.floor(Math.random() * 500),
        });
      }

      // Errors get a longer backoff. GitHub rate-limit / auth / permission
      // blocks are handled upstream in the executor, which persists a
      // `reconcileBackoffUntil` cooldown on the run so every reconcile producer
      // is paused — those do not reach this branch as errors.
      if (outcome.status === "error") {
        await enqueueReconcile(ref, {
          reason: `error_retry:${outcome.reason}`,
          delayMs: 5000 + Math.floor(Math.random() * 2500),
        });
      }
    }),
    {
      ...bullmqOpts,
      concurrency,
      // Each reconcile tick should complete quickly. Hard-kill runaway jobs.
      lockDuration: parseIntEnv("OPTIO_RECONCILE_LOCK_MS", 30_000),
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ err, jobId: job?.id }, "Reconcile job failed");
  });

  return worker;
}

// ── Resync worker ───────────────────────────────────────────────────────────

export const resyncQueue = new Queue("reconcile-resync", { ...bullmqOpts });

/**
 * Periodic resync: every N minutes, walk every non-terminal run (repo tasks
 * and Job runs, one table), PR review, and persistent agent, and enqueue a
 * reconcile key for each. Catches drift from lost events.
 */
export function startReconcileResyncWorker() {
  const intervalMs = parseIntEnv("OPTIO_RECONCILE_RESYNC_INTERVAL", 5 * 60 * 1000);

  resyncQueue.add(
    "resync",
    {},
    {
      repeat: { every: intervalMs },
    },
  );

  const worker = new Worker(
    "reconcile-resync",
    instrumentWorkerProcessor("reconcile-resync", async () => {
      const { db } = await import("../db/client.js");
      const { workRuns, prReviews, persistentAgents } = await import("../db/schema.js");
      const { sql } = await import("drizzle-orm");

      // Repo tasks and Job runs: `kind` is the run's RunKind.
      const nonTerminalRuns = await db
        .select({ id: workRuns.id, kind: workRuns.kind })
        .from(workRuns)
        .where(sql`${workRuns.state} NOT IN ('completed')`);

      const nonTerminalReviews = await db
        .select({ id: prReviews.id })
        .from(prReviews)
        .where(sql`${prReviews.state} NOT IN ('cancelled')`);

      const livePersistentAgents = await db
        .select({ id: persistentAgents.id })
        .from(persistentAgents)
        .where(sql`${persistentAgents.state} NOT IN ('archived')`);

      logger.info(
        {
          tasks: nonTerminalRuns.filter((r) => r.kind === "repo").length,
          runs: nonTerminalRuns.filter((r) => r.kind === "standalone").length,
          reviews: nonTerminalReviews.length,
          persistentAgents: livePersistentAgents.length,
        },
        "reconcile.resync.sweep",
      );

      for (const r of nonTerminalRuns) {
        await enqueueReconcile({ kind: r.kind, id: r.id }, { reason: "resync" });
      }
      for (const r of nonTerminalReviews) {
        await enqueueReconcile({ kind: "pr-review", id: r.id }, { reason: "resync" });
      }
      for (const r of livePersistentAgents) {
        await enqueueReconcile({ kind: "persistent-agent", id: r.id }, { reason: "resync" });
      }
    }),
    {
      ...bullmqOpts,
      concurrency: 1,
    },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "Reconcile resync failed");
  });

  return worker;
}

export { reconcileQueue };
