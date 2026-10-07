/**
 * The one place Optio decides how to talk to Redis.
 *
 * Two modes, picked by `REDIS_MODE`:
 *
 *  - `standalone` (default): one Redis server, `REDIS_URL`. Local installs,
 *    the Helm chart's built-in Redis, a provisioned ElastiCache node with
 *    cluster mode off.
 *  - `cluster`: a Redis Cluster behind one or more seed nodes — `REDIS_URL`
 *    is a comma-separated list of `redis[s]://[user[:pass]@]host[:port]`
 *    (one entry for ElastiCache Serverless, which always runs in cluster
 *    mode behind a single endpoint). Every client — BullMQ queues and
 *    workers, pub/sub, the rate limiter, the general-purpose client — is an
 *    `ioredis.Cluster` with the same TLS and auth, and every BullMQ queue
 *    lives under a hash-tagged prefix (`{optio}` by default) so the keys a
 *    queue's Lua scripts touch together share one hash slot. Without the
 *    tag, those scripts fail with CROSSSLOT.
 *
 * Multi-key commands outside BullMQ go through `redisScanKeys` /
 * `redisDeleteKeys`, which fan out per node in cluster mode. Keep ad-hoc
 * keys single-key (GET / SET / DEL one key, INCR, EXPIRE): they need no tag.
 *
 * See docs/redis.md.
 */
import fs from "node:fs";
import type { ConnectionOptions } from "bullmq";
import { Cluster, Redis, type ClusterNode, type ClusterOptions, type RedisOptions } from "ioredis";
import { logger } from "../logger.js";

export type RedisMode = "standalone" | "cluster";
/** A standalone client or a cluster client; both speak the same commands. */
export type RedisClient = Redis | Cluster;

export class RedisConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisConfigError";
  }
}

function resolveMode(): RedisMode {
  const raw = (process.env.REDIS_MODE ?? "standalone").trim().toLowerCase();
  if (raw === "" || raw === "standalone") return "standalone";
  if (raw === "cluster") return "cluster";
  throw new RedisConfigError(`REDIS_MODE must be "standalone" or "cluster" (got "${raw}")`);
}

/**
 * Inject `REDIS_PASSWORD` (and `REDIS_USERNAME`) into a URL that carries no
 * credentials of its own. A URL that already has a password wins.
 */
function withCredentials(base: string): string {
  const password = process.env.REDIS_PASSWORD;
  const username = process.env.REDIS_USERNAME;
  if (!password && !username) return base;

  try {
    const parsed = new URL(base);
    if (parsed.password) return base;
    if (username) parsed.username = encodeURIComponent(username);
    if (password) parsed.password = encodeURIComponent(password);
    return parsed.toString();
  } catch {
    // URL constructor doesn't handle rediss:// in all runtimes;
    // fall back to string manipulation
    const scheme = base.startsWith("rediss://") ? "rediss://" : "redis://";
    const rest = base.slice(scheme.length);
    const user = username ? encodeURIComponent(username) : "";
    return `${scheme}${user}:${encodeURIComponent(password ?? "")}@${rest}`;
  }
}

function splitUrls(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const mode = resolveMode();
const rawUrls = splitUrls(process.env.REDIS_URL ?? "redis://localhost:6379");
if (rawUrls.length === 0) {
  throw new RedisConfigError("REDIS_URL is empty");
}
if (mode === "standalone" && rawUrls.length > 1) {
  throw new RedisConfigError(
    `REDIS_URL lists ${rawUrls.length} nodes; set REDIS_MODE=cluster for a Redis Cluster`,
  );
}

/** Each seed URL with the shared credentials applied. */
const urls = rawUrls.map(withCredentials);
const primaryUrl = urls[0]!;

interface ParsedNode {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls: boolean;
}

function parseNodeUrl(url: string): ParsedNode {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RedisConfigError(`REDIS_URL entry is not a URL: ${redact(url)}`);
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new RedisConfigError(
      `REDIS_URL entry must use redis:// or rediss:// (got ${parsed.protocol})`,
    );
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    tls: parsed.protocol === "rediss:",
  };
}

/** `host:port` of a URL with its credentials dropped — for logs. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return url.replace(/[^@\s/]*@/, "***@");
  }
}

const parsedNodes = urls.map(parseNodeUrl);
const tlsEnabled = parsedNodes.some((n) => n.tls);

function buildTlsOptions(): RedisOptions["tls"] | undefined {
  // TLS is enabled when the URL uses the rediss:// scheme
  if (!tlsEnabled) {
    return undefined;
  }

  const minVersion = process.env.REDIS_TLS_MIN_VERSION ?? "TLSv1.3";
  if (minVersion !== "TLSv1.2" && minVersion !== "TLSv1.3") {
    throw new RedisConfigError(
      `REDIS_TLS_MIN_VERSION must be TLSv1.2 or TLSv1.3 (got ${minVersion})`,
    );
  }
  const tlsOpts: NonNullable<RedisOptions["tls"]> = { minVersion };

  if (process.env.REDIS_CA_CERT_PATH) {
    tlsOpts.ca = fs.readFileSync(process.env.REDIS_CA_CERT_PATH);
  }

  // Allow disabling server certificate verification for dev/test scenarios
  // where the cert CN may not match (e.g., localhost). Default: verify.
  if (process.env.REDIS_TLS_REJECT_UNAUTHORIZED === "false") {
    tlsOpts.rejectUnauthorized = false;
  }

  return tlsOpts;
}

/**
 * `OPTIO_QUEUE_PREFIX`: the BullMQ key prefix every queue, worker and
 * maintenance call uses. Standalone keeps BullMQ's `bull` (an upgrade keeps
 * its queued jobs); cluster mode defaults to `{optio}` and insists on a hash
 * tag, because BullMQ's scripts update several keys of a queue at once.
 */
function resolveQueuePrefix(): string {
  const raw = process.env.OPTIO_QUEUE_PREFIX?.trim();
  const prefix = raw || (mode === "cluster" ? "{optio}" : "bull");
  if (mode === "cluster" && !hasHashTag(prefix)) {
    throw new RedisConfigError(
      `OPTIO_QUEUE_PREFIX must contain a hash tag in cluster mode, e.g. "{optio}" (got "${prefix}")`,
    );
  }
  if (/\s/.test(prefix)) {
    throw new RedisConfigError(`OPTIO_QUEUE_PREFIX must not contain whitespace (got "${prefix}")`);
  }
  return prefix;
}

/** Redis uses the first `{...}` with a non-empty body as the hash tag. */
export function hasHashTag(key: string): boolean {
  return /\{[^{}]+\}/.test(key);
}

/**
 * `REDIS_CLUSTER_NAT_MAP`: `inner-host:port=outer-host:port,...` — the
 * address a node announces mapped to the one this process can reach, for
 * clusters behind NAT (a Docker Desktop port mapping, an SSH tunnel).
 */
function parseNatMap(): ClusterOptions["natMap"] | undefined {
  const raw = process.env.REDIS_CLUSTER_NAT_MAP?.trim();
  if (!raw) return undefined;
  const map: Record<string, { host: string; port: number }> = {};
  for (const entry of raw.split(",")) {
    const [inner, outer] = entry.split("=").map((s) => s.trim());
    if (!inner || !outer) {
      throw new RedisConfigError(
        `REDIS_CLUSTER_NAT_MAP entry must be inner=outer (got "${entry}")`,
      );
    }
    const idx = outer.lastIndexOf(":");
    if (idx <= 0) {
      throw new RedisConfigError(
        `REDIS_CLUSTER_NAT_MAP outer address needs a port (got "${outer}")`,
      );
    }
    map[inner] = { host: outer.slice(0, idx), port: Number(outer.slice(idx + 1)) };
  }
  return map;
}

/** Which mode this process runs in. */
export const redisMode: RedisMode = mode;

/** Shared Redis URL (standalone: the server; cluster: the first seed node). */
export const redisConnectionUrl = primaryUrl;

/** Every seed URL (one in standalone mode). */
export const redisConnectionUrls: readonly string[] = urls;

/** TLS options derived from the environment (undefined when TLS is off). */
export const redisTlsOptions = buildTlsOptions();

/** The BullMQ key prefix every queue uses. */
export const queuePrefix = resolveQueuePrefix();

/** Cluster seed nodes (empty in standalone mode). */
export const redisClusterNodes: readonly ClusterNode[] =
  mode === "cluster" ? parsedNodes.map((n) => ({ host: n.host, port: n.port })) : [];

const natMap = parseNatMap();

/** Per-node options shared by every cluster client. */
function clusterRedisOptions(connectionName?: string): RedisOptions {
  const first = parsedNodes[0]!;
  return {
    ...(first.username ? { username: first.username } : {}),
    ...(first.password ? { password: first.password } : {}),
    ...(redisTlsOptions ? { tls: redisTlsOptions } : {}),
    ...(connectionName ? { connectionName } : {}),
    // BullMQ's blocking commands need this on every connection a Worker may
    // duplicate; harmless elsewhere (commands wait for the reconnect).
    maxRetriesPerRequest: null,
  };
}

export function clusterOptions(connectionName?: string): ClusterOptions {
  return {
    redisOptions: clusterRedisOptions(connectionName),
    // With TLS, keep the node names CLUSTER SLOTS reports instead of
    // resolving them to IPs first: the certificate is for the hostname
    // (ElastiCache's documented ioredis setup).
    ...(redisTlsOptions ? { dnsLookup: (address, callback) => callback(null, address) } : {}),
    ...(natMap ? { natMap } : {}),
    // A managed endpoint can take a moment to answer CLUSTER SLOTS over TLS.
    slotsRefreshTimeout: 5000,
    // Keep retrying forever with a capped backoff: queues must not be
    // orphaned by a transient outage. (ioredis' default also never gives up;
    // this just bounds the wait.)
    clusterRetryStrategy: (times) => Math.min(100 * 2 ** Math.min(times, 6), 5000),
  };
}

/**
 * Log a client's errors instead of letting them surface as unhandled
 * 'error' events (which would throw). ioredis keeps reconnecting on its own.
 */
function logErrors<T extends RedisClient>(client: T, name: string): T {
  client.on("error", (err: Error) => {
    logger.warn({ err: err.message, client: name, mode }, "Redis client error (will reconnect)");
  });
  return client;
}

/**
 * A new client for this process' Redis — standalone or cluster as
 * configured. Callers own closing it (`quit()` / `disconnect()`).
 */
export function createRedisClient(
  opts: { connectionName?: string; lazyConnect?: boolean } = {},
): RedisClient {
  const name = opts.connectionName ?? "optio";
  if (mode === "cluster") {
    return logErrors(
      new Cluster([...redisClusterNodes], {
        ...clusterOptions(opts.connectionName),
        lazyConnect: opts.lazyConnect ?? false,
      }),
      name,
    );
  }
  return logErrors(
    new Redis(primaryUrl, {
      ...(redisTlsOptions ? { tls: redisTlsOptions } : {}),
      ...(opts.connectionName ? { connectionName: opts.connectionName } : {}),
      lazyConnect: opts.lazyConnect ?? false,
    }),
    name,
  );
}

/** Identify a cluster client at runtime (the union's only distinguishing flag). */
export function isClusterClient(client: RedisClient): client is Cluster {
  return (client as Cluster).isCluster === true;
}

let bullmqCluster: Cluster | null = null;

/**
 * Connection options suitable for BullMQ Queue / Worker constructors.
 *
 * Standalone: plain options (each Queue / Worker opens its own connection;
 * `maxRetriesPerRequest: null` is what BullMQ requires for blocking
 * commands). Cluster: ONE shared `ioredis.Cluster` instance — BullMQ can't
 * build a cluster client from options — which every queue reuses and every
 * worker duplicates for its blocking connection.
 */
export function getBullMQConnectionOptions(): ConnectionOptions {
  if (mode === "cluster") {
    if (!bullmqCluster) {
      // One instance for every queue; its errors are logged here (BullMQ
      // also re-emits them on each Queue / Worker).
      bullmqCluster = logErrors(
        new Cluster([...redisClusterNodes], clusterOptions("optio-bullmq")),
        "optio-bullmq",
      );
    }
    // BullMQ bundles its own ioredis type declarations; the instance is the
    // same runtime shape (duplicate(), options.redisOptions, isCluster).
    return bullmqCluster as unknown as ConnectionOptions;
  }
  return {
    url: primaryUrl,
    maxRetriesPerRequest: null,
    ...(redisTlsOptions ? { tls: redisTlsOptions } : {}),
  };
}

/**
 * Everything a BullMQ Queue or Worker needs: the connection and the key
 * prefix. Spread it into the constructor options so producers, workers and
 * queue maintenance all address the same keys.
 */
export function getBullMQOptions(): { connection: ConnectionOptions; prefix: string } {
  return { connection: getBullMQConnectionOptions(), prefix: queuePrefix };
}

/**
 * Close the shared BullMQ cluster client (tests and shutdown). A no-op in
 * standalone mode, where BullMQ owns its connections.
 */
export async function closeSharedRedisClients(): Promise<void> {
  const c = bullmqCluster;
  bullmqCluster = null;
  if (c) {
    await c.quit().catch(() => c.disconnect());
  }
}

/**
 * Resolve once the client can take commands. A cluster client knows no
 * nodes until its first CLUSTER SLOTS refresh, so anything that fans out per
 * node (`nodes("master")`) must wait for it; plain commands queue on their own.
 */
export function waitForRedisReady(client: RedisClient): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => {
      client.off("end", onEnd);
      resolve();
    };
    const onEnd = () => {
      client.off("ready", onReady);
      reject(new Error("Redis client closed before it was ready"));
    };
    client.once("ready", onReady);
    client.once("end", onEnd);
    if (client.status === "wait") client.connect().catch(() => {});
  });
}

/** The master nodes a multi-key operation must visit (one in standalone mode). */
async function dataNodes(client: RedisClient): Promise<Redis[]> {
  await waitForRedisReady(client);
  return isClusterClient(client) ? client.nodes("master") : [client];
}

/**
 * Every key matching `pattern` (SCAN, never KEYS — ElastiCache Serverless
 * has no KEYS). In cluster mode each master is scanned in turn.
 */
export async function redisScanKeys(client: RedisClient, pattern: string): Promise<string[]> {
  const found: string[] = [];
  for (const node of await dataNodes(client)) {
    const stream = node.scanStream({ match: pattern, count: 100 });
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (keys: string[]) => {
        found.push(...keys);
      });
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
  }
  return found;
}

/**
 * Delete keys that need not share a hash slot. Standalone: one DEL per
 * batch; cluster: one DEL per key (a multi-key DEL across slots is a
 * CROSSSLOT error).
 */
export async function redisDeleteKeys(
  client: RedisClient,
  keys: readonly string[],
): Promise<number> {
  if (keys.length === 0) return 0;
  let deleted = 0;
  if (isClusterClient(client)) {
    for (let i = 0; i < keys.length; i += 100) {
      const batch = keys.slice(i, i + 100);
      const counts = await Promise.all(batch.map((k) => client.del(k)));
      deleted += counts.reduce((a, b) => a + b, 0);
    }
    return deleted;
  }
  for (let i = 0; i < keys.length; i += 500) {
    deleted += await client.del(...keys.slice(i, i + 500));
  }
  return deleted;
}

export interface RedisEvictionReport {
  /** `host:port` of the node. */
  node: string;
  /** The `maxmemory_policy` INFO reports, or null when the server omits it (ElastiCache Serverless). */
  policy: string | null;
  /** `maxmemory` in bytes (0 = unlimited), or null when not reported. */
  maxmemory: number | null;
  usedMemory: number | null;
}

/**
 * What each data node says about eviction. BullMQ's queue keys carry no
 * TTL, so under `noeviction` (and ElastiCache Serverless's fixed
 * `volatile-lru`, which only evicts keys WITH a TTL) a full server rejects
 * writes loudly instead of dropping queue state; any other policy can
 * silently evict jobs. Logged at boot; `optio redis:smoke` prints it.
 */
export async function inspectRedisEviction(client: RedisClient): Promise<RedisEvictionReport[]> {
  const reports: RedisEvictionReport[] = [];
  for (const node of await dataNodes(client)) {
    const info = await node.info("memory");
    const field = (name: string): string | null => {
      const m = info.match(new RegExp(`^${name}:(.*)$`, "m"));
      return m ? m[1]!.trim() : null;
    };
    const num = (v: string | null) => (v == null || v === "" ? null : Number(v));
    reports.push({
      node: `${node.options.host ?? "?"}:${node.options.port ?? "?"}`,
      policy: field("maxmemory_policy"),
      maxmemory: num(field("maxmemory")),
      usedMemory: num(field("used_memory")),
    });
  }
  return reports;
}

/** A log-safe description of the configuration (no credentials). */
export function describeRedisConfig(): {
  mode: RedisMode;
  nodes: string[];
  tls: boolean;
  auth: boolean;
  queuePrefix: string;
} {
  return {
    mode,
    nodes: parsedNodes.map((n) => `${n.host}:${n.port}`),
    tls: tlsEnabled,
    auth: parsedNodes.some((n) => !!n.password),
    queuePrefix,
  };
}
