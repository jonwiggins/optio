import "dotenv/config";
import { initTelemetry, shutdownTelemetry } from "./telemetry.js";
import { logger } from "./logger.js";

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

const PORT = parseInt(process.env.API_PORT ?? "4000", 10);
const HOST = process.env.API_HOST ?? "0.0.0.0";

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
  // Initialize OpenTelemetry BEFORE any other imports — auto-instrumentation
  // patches module prototypes which only works before instrumented modules load.
  await initTelemetry();

  // Dynamic imports after telemetry init to ensure auto-instrumentation patches apply
  const { Queue } = await import("bullmq");
  const { buildServer } = await import("./server.js");
  const { startTaskWorker, reconcileOrphanedTasks } = await import("./workers/task-worker.js");
  const { startTicketSyncWorker } = await import("./workers/ticket-sync-worker.js");
  const { startRepoCleanupWorker } = await import("./workers/repo-cleanup-worker.js");
  const { startPrWatcherWorker } = await import("./workers/pr-watcher-worker.js");
  const { startWebhookWorker } = await import("./workers/webhook-worker.js");
  const { startScheduleWorker } = await import("./workers/schedule-worker.js");
  const { startWorkflowWorker } = await import("./workers/workflow-worker.js");
  const { getBullMQConnectionOptions } = await import("./services/redis-config.js");
  const { logTlsStackInfo, initTlsObservability } = await import("./services/tls-observability.js");

  const redisConnection = getBullMQConnectionOptions();

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
    cleanRepeatJobs("workflow-runs"),
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

  const workflowWorker = startWorkflowWorker();
  logger.info("Workflow worker started");

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
    await workflowWorker.close();
    await app.close();
    // Flush pending OTel spans/metrics with 5s timeout
    await shutdownTelemetry();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(err, "Failed to start");
  process.exit(1);
});
