/**
 * Smoke test for a Redis deployment — run it against the Redis you intend to
 * point Optio at (ElastiCache Serverless, a Redis Cluster, a managed
 * standalone server) BEFORE deploying:
 *
 *   REDIS_MODE=cluster REDIS_URL='rediss://user:pass@my-cache.serverless.use1.cache.amazonaws.com:6379' \
 *     pnpm --filter @optio/api redis:smoke
 *
 * It reads exactly the environment the API server reads (REDIS_MODE,
 * REDIS_URL, REDIS_USERNAME / REDIS_PASSWORD, REDIS_CA_CERT_PATH,
 * REDIS_TLS_*, REDIS_CLUSTER_NAT_MAP, OPTIO_QUEUE_PREFIX) and then, through
 * the same code paths the server uses:
 *
 *  1. connects and prints the topology + what each node reports about
 *     eviction (ElastiCache Serverless reports none: fixed volatile-lru);
 *  2. runs a throwaway BullMQ queue under the configured prefix —
 *     enqueue → process → complete, a delayed job, a retry, a job scheduler,
 *     getRepeatableJobs / removeRepeatableByKey, obliterate — and checks
 *     every key it created shares one hash slot (cluster mode);
 *  3. publishes and subscribes through the pub/sub clients;
 *  4. scans and deletes keys across slots (the cache-invalidation path);
 *  5. probes the commands Optio does NOT rely on but a managed service may
 *     restrict (KEYS, CONFIG, CLIENT LIST, PSUBSCRIBE), for information.
 *
 * Exit code 0 when every step Optio relies on passes. Nothing it writes
 * outlives the run (queue `optio-smoke-<random>`, keys tagged the same).
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { Queue, Worker } from "bullmq";
import {
  closeSharedRedisClients,
  createRedisClient,
  describeRedisConfig,
  getBullMQOptions,
  inspectRedisEviction,
  isClusterClient,
  redisDeleteKeys,
  redisScanKeys,
  type RedisClient,
} from "../src/services/redis-config.js";

const id = randomBytes(4).toString("hex");
const QUEUE = `optio-smoke-${id}`;
let failures = 0;

function ok(label: string, detail = "") {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}
function bad(label: string, err: unknown) {
  failures++;
  console.log(`  ✗ ${label} — ${err instanceof Error ? err.message : String(err)}`);
}
function note(label: string, detail: string) {
  console.log(`  · ${label} — ${detail}`);
}
async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const v = await fn();
    ok(label, typeof v === "string" ? v : "");
    return v;
  } catch (err) {
    bad(label, err);
    return undefined;
  }
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
async function until(fn: () => Promise<boolean> | boolean, ms: number, what: string) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`${what}: not within ${ms}ms`);
}
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

async function main() {
  const cfg = describeRedisConfig();
  console.log(`Redis smoke test (${cfg.mode})`);
  console.log(
    `  nodes: ${cfg.nodes.join(", ")}  tls: ${cfg.tls}  auth: ${cfg.auth}  prefix: ${cfg.queuePrefix}`,
  );

  const client = createRedisClient({ connectionName: "optio-smoke" });
  const clients: RedisClient[] = [client];
  const bullmq = getBullMQOptions();

  // 1. connectivity + eviction
  console.log("\n1. connection");
  await step("PING", async () => {
    const pong = await withTimeout(client.ping(), 15_000, "PING");
    if (pong !== "PONG") throw new Error(`unexpected reply ${pong}`);
    return isClusterClient(client)
      ? `${client.nodes("master").length} master node(s)`
      : "standalone";
  });
  if (isClusterClient(client)) {
    await step("CLUSTER INFO", async () => {
      const info = String(await client.cluster("INFO"));
      const state = info.match(/cluster_state:(\w+)/)?.[1];
      if (state !== "ok") throw new Error(`cluster_state is ${state}`);
      return `cluster_state:ok, slots assigned ${info.match(/cluster_slots_assigned:(\d+)/)?.[1]}`;
    });
  }
  const server = await step("INFO server", async () => {
    const info = await client.info("server");
    const version = info.match(/^(?:redis|valkey)_version:(.*)$/m)?.[1]?.trim();
    return `version ${version ?? "unknown"}`;
  });
  void server;
  const reports = await step("eviction policy", async () => {
    const r = await inspectRedisEviction(client);
    return r
      .map(
        (x) =>
          `${x.node}: ${x.policy ?? "(not reported)"}` +
          (x.maxmemory != null ? `, maxmemory ${x.maxmemory}` : "") +
          (x.usedMemory != null ? `, used ${x.usedMemory}` : ""),
      )
      .join("; ");
  });
  if (reports !== undefined) {
    const raw = await inspectRedisEviction(client);
    for (const r of raw) {
      if (r.policy === null) {
        note(
          `${r.node} eviction`,
          "policy not reported. ElastiCache Serverless is fixed at volatile-lru: only keys WITH a TTL are evicted; " +
            "queue keys have none, so a full cache rejects writes (OOM) instead of dropping them. " +
            "Set a maximum data storage limit and alarm on BytesUsedForCache and Evictions.",
        );
      } else if (r.policy !== "noeviction") {
        failures++;
        console.log(
          `  ✗ ${r.node} eviction — policy ${r.policy}: queued work can be evicted under memory pressure; set maxmemory-policy noeviction`,
        );
      }
    }
  }

  // 2. BullMQ
  console.log(`\n2. BullMQ queue "${QUEUE}" (prefix ${bullmq.prefix})`);
  const queue = new Queue(QUEUE, { ...bullmq });
  const processed: string[] = [];
  const attempts: number[] = [];
  const worker = new Worker(
    QUEUE,
    async (job) => {
      if (job.name === "retry") {
        attempts.push(job.attemptsMade);
        if (job.attemptsMade < 1) throw new Error("first attempt fails on purpose");
      }
      processed.push(job.name);
      return job.name;
    },
    { ...bullmq, concurrency: 2 },
  );
  worker.on("error", (err) => bad("worker error event", err));
  await step("worker ready", () =>
    withTimeout(
      worker.waitUntilReady().then(() => "ready"),
      30_000,
      "worker",
    ),
  );
  await step("enqueue → process → complete", async () => {
    const job = await queue.add("plain", { at: Date.now() });
    await until(() => processed.includes("plain"), 15_000, "job processed");
    await until(async () => (await job.getState()) === "completed", 15_000, "job completed");
    return `job ${job.id}`;
  });
  await step("delayed job runs after its delay", async () => {
    const t0 = Date.now();
    await queue.add("delayed", {}, { delay: 1000 });
    await until(() => processed.includes("delayed"), 15_000, "delayed job processed");
    const took = Date.now() - t0;
    if (took < 950) throw new Error(`ran after ${took}ms, before its 1000ms delay`);
    return `after ${took}ms`;
  });
  await step("retry with backoff", async () => {
    await queue.add("retry", {}, { attempts: 2, backoff: { type: "fixed", delay: 300 } });
    await until(() => processed.includes("retry"), 15_000, "retried job processed");
    return `attempts ${attempts.join(",")}`;
  });
  await step("job scheduler (recurring work) + repeatable maintenance", async () => {
    await queue.upsertJobScheduler("tick", { every: 300 }, { name: "tick" });
    await until(() => processed.filter((n) => n === "tick").length >= 2, 15_000, "two ticks");
    const repeatables = await queue.getRepeatableJobs();
    for (const r of repeatables) await queue.removeRepeatableByKey(r.key);
    const left = await queue.getRepeatableJobs();
    if (left.length !== 0) throw new Error(`${left.length} repeatable(s) left`);
    return `${repeatables.length} scheduler removed`;
  });
  if (isClusterClient(client)) {
    await step("every queue key in one hash slot", async () => {
      const keys = await redisScanKeys(client, `${bullmq.prefix}:${QUEUE}:*`);
      if (keys.length === 0) throw new Error("no keys found under the prefix");
      const slots = new Set<number>();
      for (const k of keys) slots.add(Number(await client.cluster("KEYSLOT", k)));
      if (slots.size !== 1) throw new Error(`${keys.length} keys span ${slots.size} slots`);
      return `${keys.length} keys, slot ${[...slots][0]}`;
    });
  }
  await step("obliterate", async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    const left = await redisScanKeys(client, `${bullmq.prefix}:${QUEUE}:*`);
    if (left.length) throw new Error(`${left.length} key(s) left: ${left.slice(0, 3).join(", ")}`);
    await queue.close();
    return "no keys left";
  });

  // 3. pub/sub
  console.log("\n3. pub/sub");
  await step("SUBSCRIBE / PUBLISH round trip", async () => {
    const sub = createRedisClient({ connectionName: "optio-smoke-sub" });
    clients.push(sub);
    const channel = `optio:smoke:${id}`;
    const received: string[] = [];
    let receivedAt = 0;
    sub.on("message", (_c: string, m: string) => {
      received.push(m);
      receivedAt ||= Date.now();
    });
    await sub.subscribe(channel);
    // Delivery is judged by the message arriving. PUBLISH's reply counts only
    // the subscribers on the node that took the command (Redis docs, PUBLISH);
    // in a cluster that is usually not the subscriber's node, so a delivered
    // message is counted 0 more often than not.
    const t0 = Date.now();
    let publishes = 0;
    await until(
      async () => {
        if (received.includes("hello")) return true;
        publishes++;
        await client.publish(channel, "hello");
        return false;
      },
      10_000,
      "message received",
    );
    return `delivered after ${publishes} publish${publishes === 1 ? "" : "es"}, ${receivedAt - t0}ms`;
  });

  // 4. cross-slot helpers
  console.log("\n4. multi-key helpers");
  await step("scan + delete keys across slots", async () => {
    const keys = Array.from({ length: 8 }, (_, i) => `optio:smoke:${id}:${i}`);
    for (const k of keys) await client.set(k, "1", "EX", 300);
    const found = await redisScanKeys(client, `optio:smoke:${id}:*`);
    if (found.length !== keys.length) throw new Error(`scan found ${found.length}/${keys.length}`);
    const n = await redisDeleteKeys(client, found);
    if (n !== keys.length) throw new Error(`deleted ${n}/${keys.length}`);
    return `${n} keys`;
  });

  // 5. restricted-command probes (informational)
  console.log("\n5. commands Optio does not need (informational)");
  const probe = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await withTimeout(fn(), 5000, label);
      note(label, "supported");
    } catch (err) {
      note(label, `not available (${err instanceof Error ? err.message.split("\n")[0] : err})`);
    }
  };
  const one = isClusterClient(client) ? client.nodes("master")[0]! : client;
  await probe("KEYS", () => one.keys(`optio:smoke:${id}:none`));
  await probe("CONFIG GET maxmemory-policy", () => one.config("GET", "maxmemory-policy"));
  await probe("CLIENT LIST", () => one.client("LIST"));
  await probe("PSUBSCRIBE", async () => {
    const p = createRedisClient({ connectionName: "optio-smoke-psub" });
    clients.push(p);
    await p.psubscribe(`optio:smoke:${id}:*`);
  });

  // done
  for (const c of clients) c.disconnect();
  await closeSharedRedisClients();
  console.log(failures ? `\n${failures} step(s) FAILED` : "\nall steps passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
