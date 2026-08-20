/**
 * Optio Local liveness sweeper: marks hosts offline when their daemon stops
 * pinging, and fails `launching` terminals the daemon never acked. Plain
 * interval (no BullMQ) — the checks are cheap indexed UPDATEs and running
 * once per API replica is fine (single-replica relay assumption).
 */
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";
import { sweepStaleHosts } from "../services/local-host-service.js";
import { sweepStuckLaunching } from "../services/local-terminal-service.js";

export function startLocalSweepWorker(): { close(): Promise<void> } {
  const intervalMs = parseIntEnv("OPTIO_LOCAL_SWEEP_INTERVAL", 30_000);
  const timer = setInterval(() => {
    void (async () => {
      try {
        await sweepStaleHosts();
        await sweepStuckLaunching();
      } catch (err) {
        logger.warn({ err }, "local sweep failed");
      }
    })();
  }, intervalMs);
  timer.unref();
  return {
    async close() {
      clearInterval(timer);
    },
  };
}
