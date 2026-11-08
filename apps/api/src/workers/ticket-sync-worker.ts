import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";

import { getBullMQOptions } from "../services/redis-config.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";
import { underPollerLease } from "../services/poller-lease.js";

const bullmqOpts = getBullMQOptions();

const ticketSyncQueue = new Queue("ticket-sync", { ...bullmqOpts });

/**
 * Periodic ticket sync: one sweep at a time across instances (a poller
 * lease); the sync itself claims each (source, ticket, repo) in
 * `ticket_sync_claims` before creating a task, so two sweeps that do
 * overlap still create one task per ticket.
 */
export function startTicketSyncWorker(syncFn: () => Promise<unknown>) {
  void scheduleRepeat(
    ticketSyncQueue,
    "ticket-sync.sync",
    parseIntEnv("OPTIO_TICKET_SYNC_INTERVAL", 60000), // default: 60s
  ).catch(() => {});

  const worker = new Worker(
    "ticket-sync",
    async () => {
      await underPollerLease("ticket-sync", async () => {
        logger.info("Running periodic ticket sync");
        await syncFn();
      });
    },
    {
      ...bullmqOpts,
      concurrency: 1,
    },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "Ticket sync failed");
  });

  return worker;
}
