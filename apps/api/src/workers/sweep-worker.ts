/**
 * Housekeeping (docs/plans/scale-out.md §3): one 30-second tick, on one
 * instance at a time, that runs every registered sweep — the rows that
 * coordination leaves behind and that nothing else deletes: inbound
 * webhook deliveries older than a day, expired WebSocket upgrade tokens,
 * leases that expired a day ago, and whatever another module registers
 * (`registerSweep`).
 */
import { Queue, Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { parseIntEnv } from "@optio/shared";
import { db } from "../db/client.js";
import { logger } from "../logger.js";
import { sweepLeases } from "../services/lease-service.js";
import { underPollerLease } from "../services/poller-lease.js";
import { getBullMQOptions } from "../services/redis-config.js";
// The audit trail's retention (docs/audit.md).
import { pruneAuditTrail } from "../services/audit-retention.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";

const bullmqOpts = getBullMQOptions();

export const housekeepingQueue = new Queue("housekeeping", { ...bullmqOpts });

export type Sweep = () => Promise<number | void>;

const sweeps = new Map<string, Sweep>();

/**
 * Adds a sweep to the housekeeping tick. A sweep returns how many rows it
 * removed (logged when non-zero); a sweep that throws is logged and the
 * others still run. Registering a name twice replaces the sweep.
 */
export function registerSweep(name: string, sweep: Sweep): void {
  sweeps.set(name, sweep);
}

/** The registered sweeps, in registration order (for tests). */
export function registeredSweeps(): string[] {
  return [...sweeps.keys()];
}

/** Runs every registered sweep once (the tick's body; exported for tests). */
export async function runSweeps(): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const [name, sweep] of sweeps) {
    try {
      const n = await sweep();
      if (typeof n === "number") {
        removed[name] = n;
        if (n > 0) logger.info({ sweep: name, removed: n }, "Housekeeping sweep");
      }
    } catch (err) {
      logger.warn({ err, sweep: name }, "Housekeeping sweep failed");
    }
  }
  return removed;
}

const DELIVERIES_RETENTION = "24 hours";

registerSweep("inbound-webhook-deliveries", async () => {
  const rows = await db.execute<{ source: string }>(sql`
    DELETE FROM "inbound_webhook_deliveries"
    WHERE "received_at" < now() - ${DELIVERIES_RETENTION}::interval
    RETURNING "source"`);
  return rows.length;
});

registerSweep("ws-upgrade-tokens", async () => {
  const rows = await db.execute<{ token_hash: string }>(sql`
    DELETE FROM "ws_upgrade_tokens" WHERE "expires_at" < now() RETURNING "token_hash"`);
  return rows.length;
});

registerSweep("leases", () => sweepLeases());
// Audit entries past their retention, once a day (services/audit-retention.ts).
registerSweep("audit-retention", () => pruneAuditTrail());
// Keys Optio made on model gateways, revoked when unowned and their budgets
// watched (services/gateway-key-check.ts; loaded on first use).
registerSweep("gateway-keys", async () =>
  (await import("../services/gateway-key-check.js")).gatewayKeySweep(),
);

export function startSweepWorker(): Worker {
  const intervalMs = parseIntEnv("OPTIO_HOUSEKEEPING_INTERVAL", 30_000);
  void scheduleRepeat(housekeepingQueue, "housekeeping.sweep", intervalMs, {
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 20 },
  }).catch(() => {});

  const worker = new Worker(
    "housekeeping",
    async () => {
      await underPollerLease("housekeeping", () => runSweeps());
    },
    { ...bullmqOpts, concurrency: 1 },
  );
  worker.on("failed", (_job, err) => logger.error({ err }, "Housekeeping tick failed"));
  return worker;
}
