import "dotenv/config";
import { parseIntEnv } from "@optio/shared";
import { initTelemetry, shutdownTelemetry, registerMetricCallbacks } from "./telemetry.js";
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

const PORT = parseIntEnv("API_PORT", 4000);
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
  const { startExternalPrReviewWorker } = await import("./workers/external-pr-review-worker.js");
  const { startPrReviewWorker } = await import("./workers/pr-review-worker.js");
  const { startWebhookWorker } = await import("./workers/webhook-worker.js");
  const { startWorkflowWorker } = await import("./workers/workflow-worker.js");
  const { startWorkflowTriggerWorker } = await import("./workers/workflow-trigger-worker.js");
  const { startPersistentAgentWorker } = await import("./workers/persistent-agent-worker.js");
  const { startTokenValidationWorker } = await import("./workers/token-validation-worker.js");
  const { startReconcileWorker, startReconcileResyncWorker } =
    await import("./workers/reconcile-worker.js");
  const { startSkillSyncWorker } = await import("./workers/skill-sync-worker.js");
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

  // Run database migrations before anything else.
  // Uses a custom runner instead of Drizzle's built-in migrate() because
  // Drizzle uses a watermark (highest created_at) which silently skips
  // migrations with lower timestamps — broken when switching from sequential
  // to unix-timestamp prefixes. Our runner checks by hash and uses an
  // advisory lock for multi-replica safety.
  const { db } = await import("./db/client.js");
  const { migrateSafe } = await import("./db/migrate-safe.js");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const migrationsPath = join(dirname(fileURLToPath(import.meta.url)), "db", "migrations");
  const applied = await migrateSafe(db, migrationsPath);
  logger.info({ applied }, "Database migrations applied");

  // Seed built-in connection providers (idempotent upsert)
  const { seedBuiltInProviders } = await import("./services/connection-service.js");
  await seedBuiltInProviders();
  logger.info("Built-in connection providers seeded");

  // Register observable metric gauge callbacks now that DB is available.
  // OTel SDK invokes callbacks synchronously at export time, so we maintain
  // cached counts refreshed every 30s.
  const { tasks: tasksTable, repoPods } = await import("./db/schema.js");
  const { sql: sqlFn } = await import("drizzle-orm");

  let cachedQueueDepth: Record<string, number> = {};
  let cachedActiveTasks = 0;
  let cachedPodCount: Record<string, number> = {};

  async function refreshGaugeCaches() {
    try {
      const rows = await db
        .select({ state: tasksTable.state, count: sqlFn<number>`count(*)` })
        .from(tasksTable)
        .where(sqlFn`${tasksTable.state} IN ('queued', 'provisioning', 'running')`)
        .groupBy(tasksTable.state);
      cachedQueueDepth = {};
      cachedActiveTasks = 0;
      for (const row of rows) {
        cachedQueueDepth[row.state] = Number(row.count);
        if (row.state === "running" || row.state === "provisioning") {
          cachedActiveTasks += Number(row.count);
        }
      }
    } catch {
      /* non-fatal */
    }
    try {
      const podRows = await db
        .select({ state: repoPods.state, count: sqlFn<number>`count(*)` })
        .from(repoPods)
        .groupBy(repoPods.state);
      cachedPodCount = {};
      for (const row of podRows) {
        cachedPodCount[row.state] = Number(row.count);
      }
    } catch {
      /* non-fatal */
    }
  }

  refreshGaugeCaches().catch(() => {});
  setInterval(() => refreshGaugeCaches().catch(() => {}), 30_000);

  await registerMetricCallbacks({
    queueDepth: (attrs) => cachedQueueDepth[String(attrs.state)] ?? 0,
    activeTasks: () => cachedActiveTasks,
    podCount: (attrs) => cachedPodCount[String(attrs.state)] ?? 0,
  });

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
    cleanRepeatJobs("external-pr-review"),
    cleanRepeatJobs("repo-cleanup"),
    cleanRepeatJobs("ticket-sync"),
    cleanRepeatJobs("workflow-runs"),
    cleanRepeatJobs("workflow-trigger-checker"),
    cleanRepeatJobs("token-validation"),
    cleanRepeatJobs("reconcile"),
    cleanRepeatJobs("reconcile-resync"),
    cleanRepeatJobs("skill-sync"),
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

  const externalPrReviewWorker = startExternalPrReviewWorker();
  logger.info("External PR review worker started");

  const prReviewWorker = startPrReviewWorker();
  logger.info("PR review run worker started");

  const webhookWorker = startWebhookWorker();
  logger.info("Webhook worker started");

  const workflowWorker = startWorkflowWorker();
  logger.info("Workflow worker started");

  const workflowTriggerWorker = startWorkflowTriggerWorker();
  logger.info("Workflow trigger worker started");

  const persistentAgentWorker = startPersistentAgentWorker();
  logger.info("Persistent agent worker started");

  const tokenValidationWorker = startTokenValidationWorker();
  logger.info("Token validation worker started");

  const reconcileWorker = startReconcileWorker();
  const reconcileResyncWorker = startReconcileResyncWorker();
  logger.info("Reconcile workers started");

  const skillSyncWorker = startSkillSyncWorker();
  logger.info("Skill sync worker started");

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
    await externalPrReviewWorker.close();
    await prReviewWorker.close();
    await webhookWorker.close();
    await workflowWorker.close();
    await persistentAgentWorker.close();
    await workflowTriggerWorker.close();
    await tokenValidationWorker.close();
    await reconcileWorker.close();
    await reconcileResyncWorker.close();
    await skillSyncWorker.close();
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
