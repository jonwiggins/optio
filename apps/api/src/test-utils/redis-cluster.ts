/**
 * The Redis Cluster the cluster-mode tests run against — the three-master
 * container scripts/test-infra.sh starts (OPTIO_TEST_REDIS_CLUSTER_URL, a
 * comma-separated seed list). Standalone test Redis keeps per-file isolation
 * with logical databases; a cluster has only db 0, so cluster-mode tests
 * isolate by KEY PREFIX instead: every queue lives under a hash-tagged
 * prefix unique to the test file (`clusterTestPrefix`) and every ad-hoc key
 * the test writes carries the same tag.
 */
import { randomBytes } from "node:crypto";
import net from "node:net";

export const DEFAULT_TEST_REDIS_CLUSTER_URL =
  "redis://127.0.0.1:63791,redis://127.0.0.1:63792,redis://127.0.0.1:63793";

export function testRedisClusterUrl(): string {
  return process.env.OPTIO_TEST_REDIS_CLUSTER_URL || DEFAULT_TEST_REDIS_CLUSTER_URL;
}

/** A hash-tagged prefix no other concurrent test file shares. */
export function clusterTestPrefix(tier: string): string {
  return `{optio-${tier}-${process.pid}-${randomBytes(3).toString("hex")}}`;
}

/** True when the first seed node of the test cluster accepts TCP connections. */
export async function testRedisClusterReachable(): Promise<boolean> {
  const first = testRedisClusterUrl().split(",")[0]!.trim();
  let hostname: string;
  let port: number;
  try {
    const u = new URL(first);
    hostname = u.hostname;
    port = Number(u.port || 6379);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port, timeout: 1500 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    const fail = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once("error", fail);
    socket.once("timeout", fail);
  });
}

/**
 * Point `redis-config.ts` at the test cluster for the rest of this process.
 * Call BEFORE the first (dynamic) import of anything that reads Redis
 * configuration; returns the prefix the file's queues use.
 */
export function useTestRedisCluster(tier: string): string {
  const prefix = clusterTestPrefix(tier);
  process.env.REDIS_MODE = "cluster";
  process.env.REDIS_URL = testRedisClusterUrl();
  process.env.OPTIO_QUEUE_PREFIX = prefix;
  delete process.env.REDIS_PASSWORD;
  delete process.env.REDIS_USERNAME;
  return prefix;
}
