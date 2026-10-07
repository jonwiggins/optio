/**
 * Cluster mode (REDIS_MODE=cluster) against a REAL Redis Cluster: the
 * three-master container scripts/test-infra.sh starts. Skips itself when the
 * cluster is unreachable (OPTIO_TEST_NO_DOCKER without one).
 *
 * What a standalone Redis never exercises:
 *  - every key of a BullMQ queue hashes to ONE slot under the tagged prefix,
 *    so its multi-key Lua scripts never raise CROSSSLOT;
 *  - enqueue → execute → complete, retries with backoff, delayed jobs,
 *    schedulers (recurring work), removing a queued job (cancellation) and
 *    queue maintenance (getRepeatableJobs / obliterate) all through
 *    `getBullMQOptions()` — producers, workers and maintenance alike;
 *  - pub/sub through cluster clients, and reconnects: after the server kills
 *    every connection, workers resume and subscriptions re-arm;
 *  - the cross-slot helpers (`redisScanKeys` / `redisDeleteKeys`) that the
 *    agent-options cache invalidation uses.
 *
 * The per-file setup pointed REDIS_URL at a standalone logical DB; this file
 * re-points the process at the cluster BEFORE importing redis-config (which
 * reads its env at import), with a hash-tagged prefix unique to the file.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, Worker, type Job } from "bullmq";
import { testRedisClusterReachable, useTestRedisCluster } from "../test-utils/redis-cluster.js";

const clusterUp = await testRedisClusterReachable();
if (!clusterUp) {
  console.warn(
    "[redis-cluster.int] test Redis Cluster unreachable (bash scripts/test-infra.sh start) — skipping",
  );
}

const prefix = clusterUp ? useTestRedisCluster("it") : "";

type RedisConfig = typeof import("./redis-config.js");
let cfg: RedisConfig;
let admin: import("ioredis").Cluster;
const queues: Queue[] = [];
const workers: Worker[] = [];
const clients: Array<{ disconnect(): void }> = [];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until<T>(fn: () => Promise<T | false | null | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms}ms`);
    await sleep(50);
  }
}

function queue(name: string): Queue {
  const q = new Queue(name, { ...cfg.getBullMQOptions() });
  queues.push(q);
  return q;
}

function worker(name: string, fn: (job: Job) => Promise<unknown>, concurrency = 2): Worker {
  const w = new Worker(name, fn, { ...cfg.getBullMQOptions(), concurrency });
  w.on("error", () => {});
  workers.push(w);
  return w;
}

async function slotOf(key: string): Promise<number> {
  return Number(await admin.cluster("KEYSLOT", key));
}

/** Every key of this file (all carry the file's hash tag), across all masters. */
async function fileKeys(): Promise<string[]> {
  return cfg.redisScanKeys(admin, `${prefix}*`);
}

/**
 * Drop every connection the cluster holds except the admin's own (CLIENT
 * KILL skips the caller): what a failover, a maintenance restart or an idle
 * timeout does to a long-lived process.
 */
async function killAllConnections(): Promise<void> {
  for (const node of admin.nodes("master")) {
    await node.client("KILL", "TYPE", "normal");
    await node.client("KILL", "TYPE", "pubsub");
  }
}

describe.skipIf(!clusterUp)("Redis Cluster mode", () => {
  beforeAll(async () => {
    cfg = await import("./redis-config.js");
    expect(cfg.redisMode).toBe("cluster");
    expect(cfg.queuePrefix).toBe(prefix);
    admin = cfg.createRedisClient({ connectionName: "it-admin" }) as import("ioredis").Cluster;
    clients.push(admin);
    await until(async () => (await admin.ping()) === "PONG");
    expect(admin.nodes("master").length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  afterAll(async () => {
    for (const w of workers) await w.close().catch(() => {});
    for (const q of queues) {
      await q.obliterate({ force: true }).catch(() => {});
      await q.close().catch(() => {});
    }
    // Anything left under the file's tag (ad-hoc keys).
    if (admin) await cfg.redisDeleteKeys(admin, await fileKeys()).catch(() => {});
    await cfg?.closeSharedRedisClients();
    for (const c of clients) c.disconnect();
  }, 30_000);

  it("puts every key of a queue in one hash slot, so BullMQ's multi-key scripts never CROSSSLOT", async () => {
    const q = queue("slots");
    await q.add("a", { n: 1 });
    await q.add("b", { n: 2 }, { delay: 60_000 });
    await q.add("c", { n: 3 }, { priority: 2 });
    await q.upsertJobScheduler("every-minute", { every: 60_000 }, { name: "tick" });

    const keys = (await fileKeys()).filter((k) => k.startsWith(`${prefix}:slots:`));
    // wait, delayed, prioritized, meta, id, the scheduler and its jobs, …
    expect(keys.length).toBeGreaterThanOrEqual(6);
    const slots = new Set(await Promise.all(keys.map(slotOf)));
    expect([...slots]).toEqual([await slotOf(prefix)]);

    // The same keys WITHOUT the tag would spread over the cluster.
    const untagged = new Set(await Promise.all(keys.map((k) => slotOf(k.replace(/[{}]/g, "")))));
    expect(untagged.size).toBeGreaterThan(1);

    // And a multi-key command across slots is exactly the error the tag prevents.
    await expect(admin.del("{a}1", "{b}2")).rejects.toThrow(/CROSSSLOT/);
  });

  it("enqueue → execute → complete", async () => {
    const q = queue("run");
    const done: string[] = [];
    worker("run", async (job) => {
      done.push(job.data.id);
      return { ok: true };
    });
    const id = randomUUID();
    const job = await q.add("work", { id });
    await until(async () => done.includes(id));
    await until(async () => (await job.getState()) === "completed");
    expect(await job.getState()).toBe("completed");
    expect((await q.getJobCounts()).completed).toBeGreaterThanOrEqual(1);
  });

  it("retries a failing job with backoff until it succeeds", async () => {
    const q = queue("retry");
    const seen: number[] = [];
    worker("retry", async (job) => {
      seen.push(job.attemptsMade);
      if (job.attemptsMade < 2) throw new Error(`flaky attempt ${job.attemptsMade}`);
      return "finally";
    });
    const job = await q.add("flaky", {}, { attempts: 3, backoff: { type: "fixed", delay: 100 } });
    await until(async () => (await job.getState()) === "completed", 20_000);
    expect(seen).toEqual([0, 1, 2]);
    const fresh = await q.getJob(job.id!);
    expect(fresh?.attemptsMade).toBe(3);
    expect(fresh?.returnvalue).toBe("finally");
  });

  it("runs a delayed job after its delay, not before", async () => {
    const q = queue("delayed");
    let ranAt = 0;
    worker("delayed", async () => {
      ranAt = Date.now();
    });
    const addedAt = Date.now();
    const job = await q.add("later", {}, { delay: 700 });
    expect(await job.getState()).toBe("delayed");
    await until(async () => ranAt > 0, 10_000);
    expect(ranAt - addedAt).toBeGreaterThanOrEqual(650);
  });

  it("fires scheduled (recurring) work and stops when the scheduler is removed", async () => {
    const q = queue("scheduled");
    let ticks = 0;
    worker("scheduled", async () => {
      ticks++;
    });
    await q.upsertJobScheduler("tick", { every: 200 }, { name: "tick" });
    await until(async () => ticks >= 3, 10_000);

    // The maintenance path index.ts runs at boot: list and remove by key.
    const repeatables = await q.getRepeatableJobs();
    expect(repeatables.map((r) => r.name)).toEqual(["tick"]);
    for (const r of repeatables) await q.removeRepeatableByKey(r.key);
    expect(await q.getRepeatableJobs()).toEqual([]);

    await sleep(600);
    const after = ticks;
    await sleep(600);
    expect(ticks).toBe(after);
  });

  it("removes a queued or delayed job before it runs (cancellation)", async () => {
    const q = queue("cancel");
    const ran: string[] = [];
    const delayed = await q.add("delayed", { id: "d" }, { delay: 500 });
    await delayed.remove();
    expect(await q.getJob(delayed.id!)).toBeUndefined();

    // A waiting job removed before any worker exists never runs either.
    const waiting = await q.add("waiting", { id: "w" });
    await waiting.remove();
    worker("cancel", async (job) => {
      ran.push(job.data.id);
    });
    const kept = await q.add("kept", { id: "k" });
    await until(async () => (await kept.getState()) === "completed");
    await sleep(700);
    expect(ran).toEqual(["k"]);
  });

  it("delivers pub/sub through cluster clients and re-arms subscriptions after a reconnect", async () => {
    const channel = `optio:test:${prefix}`;
    const subscriber = cfg.createRedisClient({ connectionName: "it-sub" });
    clients.push(subscriber);
    const received: string[] = [];
    subscriber.on("message", (_ch: string, msg: string) => received.push(msg));
    await subscriber.subscribe(channel);

    const publisher = cfg.createRedisClient({ connectionName: "it-pub" });
    clients.push(publisher);
    await until(async () => (await publisher.publish(channel, "one")) >= 1);
    await until(async () => received.includes("one"));

    await killAllConnections();
    // ioredis reconnects and re-issues SUBSCRIBE on its own; publishing until
    // a subscriber is counted again proves the subscription came back.
    await until(async () => {
      const n = await publisher.publish(channel, "two").catch(() => 0);
      return n >= 1;
    }, 15_000);
    await until(async () => received.includes("two"));
  });

  it("keeps processing after every connection is killed (worker + producer reconnect)", async () => {
    const q = queue("reconnect");
    const done: string[] = [];
    const w = worker("reconnect", async (job) => {
      done.push(job.data.id);
    });
    await w.waitUntilReady();
    await q.add("before", { id: "before" });
    await until(async () => done.includes("before"));

    await killAllConnections();
    await until(
      async () => (await q.add("after", { id: "after" }).catch(() => null)) !== null,
      15_000,
    );
    await until(async () => done.includes("after"), 20_000);
  });

  it("scans and deletes keys that live in different slots (agent-options cache invalidation)", async () => {
    // No hash tag (the braces are stripped): the keys spread across slots.
    const tag = `${prefix.replace(/[{}]/g, "")}-cache`;
    const keys = Array.from({ length: 12 }, (_, i) => `optio:agent-options:${tag}:${i}`);
    for (const k of keys) await admin.set(k, "1", "EX", 120);
    expect(new Set(await Promise.all(keys.map(slotOf))).size).toBeGreaterThan(1);

    const found = await cfg.redisScanKeys(admin, `optio:agent-options:${tag}:*`);
    expect(found.sort()).toEqual([...keys].sort());
    expect(await cfg.redisDeleteKeys(admin, found)).toBe(keys.length);
    expect(await cfg.redisScanKeys(admin, `optio:agent-options:${tag}:*`)).toEqual([]);
  });

  it("obliterate leaves no key of the queue behind under the prefix", async () => {
    const q = queue("gone");
    await q.add("x", {});
    await q.add("y", {}, { delay: 60_000 });
    expect((await fileKeys()).some((k) => k.startsWith(`${prefix}:gone:`))).toBe(true);
    await q.obliterate({ force: true });
    expect((await fileKeys()).filter((k) => k.startsWith(`${prefix}:gone:`))).toEqual([]);
  });

  it("reports what each master says about eviction", async () => {
    const reports = await cfg.inspectRedisEviction(admin);
    expect(reports.length).toBeGreaterThanOrEqual(3);
    for (const r of reports) {
      expect(r.node).toMatch(/^127\.0\.0\.1:\d+$/);
      expect(typeof r.policy).toBe("string");
      expect(r.usedMemory).toBeGreaterThan(0);
    }
  });
});
