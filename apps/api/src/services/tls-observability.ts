import diagnosticsChannel from "node:diagnostics_channel";
import { logger } from "../logger.js";

/**
 * Per-connection TLS key-exchange group counter.
 * Key format: "host|group"
 */
const counter = new Map<string, number>();

let flushInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Log the TLS stack info at API startup: Node version, OpenSSL version,
 * and whether the OpenSSL version supports post-quantum key exchange.
 */
export function logTlsStackInfo(): void {
  const opensslVersion = process.versions.openssl ?? "unknown";
  // OpenSSL >= 3.5.0 ships X25519MLKEM768 by default
  const pqReady = compareVersions(opensslVersion, "3.5.0") >= 0;

  logger.info(
    {
      nodeVersion: process.version,
      opensslVersion,
      pqReady,
    },
    "TLS stack",
  );
}

/**
 * Subscribe to undici's diagnostics channel to observe TLS key-exchange
 * groups negotiated per upstream connection. Logs a periodic summary.
 */
export function initTlsObservability(): void {
  diagnosticsChannel.subscribe("undici:client:connected", ({ socket, connectParams }: any) => {
    const host: string = connectParams?.host ?? "unknown";
    const group: string = (socket as any)?.getEphemeralKeyInfo?.()?.name ?? "unknown";
    const key = `${host}|${group}`;
    counter.set(key, (counter.get(key) ?? 0) + 1);
  });

  // Flush observed groups to structured logs every 60 seconds
  flushInterval = setInterval(() => {
    flushTlsGroupLogs();
  }, 60_000);

  // Allow the process to exit even if the interval is active
  if (flushInterval.unref) {
    flushInterval.unref();
  }
}

/**
 * Flush current TLS group observations to structured logs and clear counters.
 */
function flushTlsGroupLogs(): void {
  for (const [key, count] of counter) {
    const [host, group] = key.split("|");
    logger.debug({ host, group, count }, "tls_group_observed");
  }
  counter.clear();
}

/**
 * Return a snapshot of current TLS group counts (for testing and metrics).
 */
export function getTlsGroupCounts(): Array<{
  host: string;
  group: string;
  count: number;
}> {
  const result: Array<{ host: string; group: string; count: number }> = [];
  for (const [key, count] of counter) {
    const [host, group] = key.split("|");
    result.push({ host, group, count });
  }
  return result;
}

/**
 * Clear all recorded TLS group counts.
 */
export function resetTlsGroupCounts(): void {
  counter.clear();
}

/**
 * Compare two semver-like version strings (e.g. "3.5.0" vs "3.4.1").
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
