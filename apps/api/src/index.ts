import "dotenv/config";
import { parseIntEnv } from "@optio/shared";
import { initTelemetry, shutdownTelemetry, registerMetricCallbacks } from "./telemetry.js";
import { logger } from "./logger.js";
import { INSTANCE_ID } from "./services/instance.js";

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
  const { startReconcileWorker, startReconcileResyncWorker, kickResync } =
    await import("./workers/reconcile-worker.js");
  const { startSkillSyncWorker } = await import("./workers/skill-sync-worker.js");
  const { startConfigSyncWorker } = await import("./workers/config-sync-worker.js");
  const { startSweepWorker } = await import("./workers/sweep-worker.js");
  const { REPEAT_QUEUE_NAMES, removeLegacyRepeatables } = await import("./services/repeat-jobs.js");
  const { getBullMQOptions, describeRedisConfig, inspectRedisEviction, closeSharedRedisClients } =
    await import("./services/redis-config.js");
  const { logTlsStackInfo, initTlsObservability } = await import("./services/tls-observability.js");

  const bullmqOpts = getBullMQOptions();

  /**
   * Every periodic worker registers its tick as a job scheduler with a
   * stable id (services/repeat-jobs.ts), so instances never wipe each
   * other's schedules. What a build before that registered — hash-keyed
   * repeatables — would tick beside them; remove those once per boot.
   */
  async function cleanLegacyRepeatJobs(queueName: (typeof REPEAT_QUEUE_NAMES)[number]) {
    const queue = new Queue(queueName, { ...bullmqOpts });
    try {
      await removeLegacyRepeatables(queue, queueName);
    } finally {
      await queue.close();
    }
  }

  // Validate encryption key before anything else — fail fast on weak/missing keys
  const { validateEncryptionKey } = await import("./services/secret-service.js");
  validateEncryptionKey();

  // Redis: say how this process connects and what each node reports about
  // eviction. Queue keys carry no TTL, so under noeviction — and ElastiCache
  // Serverless's fixed volatile-lru, which evicts only keys WITH a TTL — a
  // full server rejects writes loudly; any other policy can drop queued work
  // silently (docs/redis.md).
  {
    const { getRedisClient } = await import("./services/event-bus.js");
    const redisInfo = describeRedisConfig();
    try {
      const reports = await Promise.race([
        inspectRedisEviction(getRedisClient()),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed out after 10s")), 10_000).unref(),
        ),
      ]);
      if (reports.length === 0) {
        logger.warn(redisInfo, "Redis connected but reported no data nodes");
      }
      for (const r of reports) {
        if (r.policy === null) {
          logger.info(
            { ...redisInfo, node: r.node },
            "Redis connected; the server does not report an eviction policy (ElastiCache Serverless evicts only keys with a TTL, so queue state is kept and writes fail when the cache is full)",
          );
        } else if (r.policy !== "noeviction") {
          logger.warn(
            { ...redisInfo, node: r.node, policy: r.policy, maxmemory: r.maxmemory },
            "Redis eviction policy is not noeviction: queued work can be evicted under memory pressure",
          );
        } else {
          logger.info(
            { ...redisInfo, node: r.node, policy: r.policy, maxmemory: r.maxmemory },
            "Redis connected",
          );
        }
      }
    } catch (err) {
      logger.warn(
        { ...redisInfo, err: err instanceof Error ? err.message : String(err) },
        "Could not inspect Redis (continuing; clients reconnect on their own)",
      );
    }
  }

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
  logger.info({ instanceId: INSTANCE_ID }, "API instance");

  // Heal contradictory (scope='global', workspace_id IS NOT NULL) secret rows
  // left over from issue #509. Idempotent — a no-op once the data is clean.
  const { healContradictoryGlobalSecrets, healWorkspaceBoundUserSecrets } =
    await import("./services/secret-service.js");
  await healContradictoryGlobalSecrets().catch((err) =>
    logger.error({ err }, "healContradictoryGlobalSecrets failed at boot"),
  );
  // Private (scope='user') secrets saved bound to a workspace could never be
  // decrypted at run time; re-bind them. Idempotent.
  await healWorkspaceBoundUserSecrets().catch((err) =>
    logger.error({ err }, "healWorkspaceBoundUserSecrets failed at boot"),
  );

  // Seed built-in connection providers (idempotent upsert)
  const { seedBuiltInProviders, sealPlaintextConnectionSecrets } =
    await import("./services/connection-service.js");
  await seedBuiltInProviders();
  logger.info("Built-in connection providers seeded");
  // The organization's starter prompts (services/starter-prompts.ts): added
  // the first time, then only the ones a newer version brings. Idempotent.
  const { seedStarterPrompts } = await import("./services/starter-prompts.js");
  await seedStarterPrompts().catch((err) =>
    logger.error({ err }, "seedStarterPrompts failed at boot"),
  );

  // Connections made before v2 keep their credentials in the plain config:
  // move them into the encrypted column (idempotent).
  await sealPlaintextConnectionSecrets().catch((err) =>
    logger.error({ err }, "sealPlaintextConnectionSecrets failed at boot"),
  );

  // Register observable metric gauge callbacks now that DB is available.
  // OTel SDK invokes callbacks synchronously at export time, so we maintain
  // cached counts refreshed every 30s.
  const { tasks: tasksTable, agentPods } = await import("./db/schema.js");
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
        .select({ state: agentPods.state, count: sqlFn<number>`count(*)` })
        .from(agentPods)
        .where(sqlFn`${agentPods.pool} = 'repo'`)
        .groupBy(agentPods.state);
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
  // Local hosts are owned by lease from the first daemon hello on, so other
  // instances can route to them (docs/plans/scale-out.md §4).
  const { enableLocalCluster } = await import("./services/local-relay.js");
  enableLocalCluster();
  const { recoverSessionTurns } = await import("./services/session-turn-service.js");
  await recoverSessionTurns();
  // Runs in flight are left alone: their agents keep going in their pods
  // under the run protocol, and the attach sweep re-attaches them to
  // whichever instance is up (docs/plans/scale-out.md §2).

  // Bind HTTP server first so turbo sees output quickly.
  // Heavy Redis/BullMQ work is deferred to after listen() to avoid
  // blocking Turborepo's process management and stalling sibling
  // dev tasks (e.g. @optio/web never starting).
  await app.listen({ port: PORT, host: HOST });
  logger.info(`API server listening on ${HOST}:${PORT}`);

  // Optio Local across instances (local-relay.ts / local-bus.ts): the bus
  // in the background like the session bus; until it is up, Local works on
  // the daemons and viewers connected to this instance.
  const { localBus } = await import("./services/local-bus.js");
  localBus.startInBackground();

  // Session chat frames and control from every other instance (session-bus.ts).
  // In the background, retried with backoff: REST serves while Redis is down,
  // and a chat socket that connects before the bus is up gets other
  // instances' frames from then on (a reconnect replays history).
  const { startSessionBusInBackground, stopSessionBus } = await import("./services/session-bus.js");
  startSessionBusInBackground();

  // Log TLS stack info and start observing negotiated key-exchange groups
  logTlsStackInfo();
  initTlsObservability();

  // --- Background initialization (after listen) ---

  // Repeat jobs an older build registered (see cleanLegacyRepeatJobs).
  await Promise.all(REPEAT_QUEUE_NAMES.map((q) => cleanLegacyRepeatJobs(q)));

  // Re-enqueue queued work that lost its job (a Redis restart) before the
  // workers start, so a newly claimed run is never mistaken for an orphan.
  await reconcileOrphanedTasks();

  // Start BullMQ workers (each upserts its repeat job scheduler)
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
  // Runs whose attachment expired (the instance holding them went away)
  // get a reconcile pass every 30 s, which re-attaches them here or
  // elsewhere; a boot asks for one right away, and for a full resync, so
  // nothing a restart interrupted waits for the periodic one
  // (docs/plans/scale-out.md §2).
  const { startAttachSweepWorker, sweepExpiredAttachments } =
    await import("./workers/attach-sweep-worker.js");
  const attachSweepWorker = startAttachSweepWorker();
  sweepExpiredAttachments().catch((err) =>
    logger.warn({ err }, "Boot-time attachment sweep failed"),
  );
  kickResync().catch((err) => logger.warn({ err }, "Boot-time resync kick failed"));
  logger.info("Reconcile workers started");

  const skillSyncWorker = startSkillSyncWorker();
  logger.info("Skill sync worker started");

  const { startLocalSweepWorker } = await import("./workers/local-sweep-worker.js");
  const localSweepWorker = startLocalSweepWorker();
  logger.info("Local sweep worker started");

  const { startDirectorySyncWorker } = await import("./workers/directory-sync-worker.js");
  const directorySyncWorker = startDirectorySyncWorker();
  const sweepWorker = startSweepWorker();
  const { startDeliveryWorker } = await import("./workers/trigger-delivery-worker.js");
  const deliveryWorker = startDeliveryWorker();
  logger.info("Housekeeping worker started");

  const { startGlanceSweepWorker } = await import("./workers/glance-sweep-worker.js");
  const glanceSweepWorker = startGlanceSweepWorker();
  const { startSessionMessageWorker } = await import("./workers/session-message-worker.js");
  const sessionMessageWorker = startSessionMessageWorker();
  logger.info("Glance sweep worker started");

  // Config as code: the configuration directory, when the deployment has one.
  const configSyncWorker = startConfigSyncWorker();

  // Check if metrics-server is available
  checkMetricsServer().catch(() => {});

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await directorySyncWorker.close();
    await sessionMessageWorker.close();
    // First: let go of every run this instance streams — the exec severed,
    // the lease given up now — so another instance picks them up in
    // seconds (run-attachment.ts). The agents keep running in their pods.
    // Runs past their stream finish settling here first (bounded).
    const { detachAll } = await import("./services/run-attachment.js");
    const { detached, settled } = await detachAll().catch((err) => {
      logger.warn({ err }, "Failed to detach from runs on shutdown");
      return { detached: 0, settled: 0 };
    });
    if (detached > 0 || settled > 0) {
      logger.info({ detached, settled }, "Detached from runs; they continue in their pods");
    }
    await attachSweepWorker.close();
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
    await localSweepWorker.close();
    await sweepWorker.close();
    await deliveryWorker.close();
    await glanceSweepWorker.close();
    await configSyncWorker?.close();
    await app.close();
    await stopSessionBus();
    await localBus.stop();
    await closeSharedRedisClients();
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
