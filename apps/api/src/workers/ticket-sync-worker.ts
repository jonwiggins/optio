import { Queue, Worker } from "bullmq";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";

import { getBullMQConnectionOptions } from "../services/redis-config.js";

const connectionOpts = getBullMQConnectionOptions();

export const ticketSyncQueue = new Queue("ticket-sync", { connection: connectionOpts });

export function startTicketSyncWorker(syncFn: () => Promise<unknown>) {
  // Add repeatable job for periodic sync
  ticketSyncQueue.add(
    "sync",
    {},
    {
      repeat: {
        every: parseIntEnv("OPTIO_TICKET_SYNC_INTERVAL", 60000), // default: 60s
      },
    },
  );

  const worker = new Worker(
    "ticket-sync",
    async () => {
      logger.info("Running periodic ticket sync");
      await syncFn();
    },
    {
      connection: connectionOpts,
      concurrency: 1,
    },
  );

  worker.on("failed", (_job, err) => {
    logger.error({ err }, "Ticket sync failed");
  });

  return worker;
}
