import "dotenv/config";
import { Queue } from "bullmq";
import { buildServer } from "./server.js";
import { startTaskWorker, reconcileOrphanedTasks } from "./workers/task-worker.js";
import { startTicketSyncWorker } from "./workers/ticket-sync-worker.js";
import { startRepoCleanupWorker } from "./workers/repo-cleanup-worker.js";
import { startPrWatcherWorker } from "./workers/pr-watcher-worker.js";
import { startWebhookWorker } from "./workers/webhook-worker.js";
import { startScheduleWorker } from "./workers/schedule-worker.js";
import { logger } from "./logger.js";
import { logTlsStackInfo, initTlsObservability } from "./services/tls-observability.js";

const redisConnection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  maxRetriesPerRequest: null,
};

/**
 * Remove all stale repeatable jobs from a queue before re-registering.
 * Prevents duplicate/orphaned repeat jobs after server restarts.
 */
async function cleanRepeatJobs(queueName: string) {
  const queue = new Queue(queueName, { connection: redisConnection });
  try {
    const repeatableJobs = await queue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await queue.removeRepeatableByKey(job.key);
    }
    if (repeatableJobs.length > 0) {
      logger.info(
        { queue: queueName, removed: repeatableJobs.length },
        "Cleaned stale repeat jobs",
      );
    }
  } finally {
    await queue.close();
  }
}

const PORT = parseInt(process.env.API_PORT ?? "4000", 10);
const HOST = process.env.API_HOST ?? "0.0.0.0";

// Prevent Redis connection errors from crashing the process
process.on("uncaughtException", (err) => {
  if (err.message?.includes("Connection is closed") || err.message?.includes("ECONNREFUSED")) {
    logger.warn({ err: err.message }, "Redis connection error (will reconnect)");
    return;
  }
  logger.error(err, "Uncaught exception");
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason, promise }, "Unhandled promise rejection");
  // Let it propagate to uncaughtException handler for clean shutdown
  throw reason;
});

async function checkMetricsServer() {
  try {
    const { KubeConfig, CustomObjectsApi } = await import("@kubernetes/client-node");
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const api = kc.makeApiClient(CustomObjectsApi);
    const res = await api.listClusterCustomObject({
      group: "metrics.k8s.io",
      version: "v1beta1",
      plural: "nodes",
    });
    if (res && (res as any).items) {
      logger.info("metrics-server detected");
    } else {
      throw new Error("No items in response");
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "metrics-server not detected — resource utilization will be unavailable. " +
        "Install with: kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml",
    );
  }
}

async function main() {
  // Validate encryption key before anything else — fail fast on weak/missing keys
  const { validateEncryptionKey } = await import("./services/secret-service.js");
  validateEncryptionKey();

  // Run database migrations before anything else
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { db } = await import("./db/client.js");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const migrationsPath = join(dirname(fileURLToPath(import.meta.url)), "db", "migrations");
  await migrate(db, { migrationsFolder: migrationsPath });
  logger.info("Database migrations applied");

  const app = await buildServer();

  // Bind HTTP server first so turbo sees output quickly.
  // Heavy Redis/BullMQ work is deferred to after listen() to avoid
  // blocking Turborepo's process management and stalling sibling
  // dev tasks (e.g. @optio/web never starting).
  await app.listen({ port: PORT, host: HOST });
  logger.info(`API server listening on ${HOST}:${PORT}`);

  // Log TLS stack info and start observing negotiated key-exchange groups
  logTlsStackInfo();
  initTlsObservability();

  // --- Background initialization (after listen) ---

  // Clean stale repeat jobs from previous server sessions
  await Promise.all([
    cleanRepeatJobs("pr-watcher"),
    cleanRepeatJobs("repo-cleanup"),
    cleanRepeatJobs("ticket-sync"),
    cleanRepeatJobs("schedule-checker"),
  ]);

  // Start BullMQ workers (each re-registers its repeat job)
  const worker = startTaskWorker();
  logger.info("Task worker started");

  const { syncAllTickets } = await import("./services/ticket-sync-service.js");
  const ticketSyncWorker = startTicketSyncWorker(syncAllTickets);
  logger.info("Ticket sync worker started");

  const repoCleanupWorker = startRepoCleanupWorker();
  logger.info("Repo cleanup worker started");

  const prWatcherWorker = startPrWatcherWorker();
  logger.info("PR watcher worker started");

  const webhookWorker = startWebhookWorker();
  logger.info("Webhook worker started");

  const scheduleWorker = startScheduleWorker();
  logger.info("Schedule worker started");

  // Check if metrics-server is available
  checkMetricsServer().catch(() => {});

  // Re-enqueue any tasks orphaned by a Redis restart.
  // The heavy obliterate() call runs last to minimize startup impact.
  reconcileOrphanedTasks().catch((err) => {
    logger.error(err, "Failed to reconcile orphaned tasks");
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await worker.close();
    await ticketSyncWorker.close();
    await repoCleanupWorker.close();
    await prWatcherWorker.close();
    await webhookWorker.close();
    await scheduleWorker.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(err, "Failed to start");
  process.exit(1);
});
