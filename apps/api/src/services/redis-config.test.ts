import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";

// Mock fs at the top level — vi.mock is hoisted
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
  },
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * ioredis stand-ins that record their constructor arguments instead of
 * opening sockets: the module under test only builds clients.
 */
const constructed = vi.hoisted(() => [] as Array<{ kind: "redis" | "cluster"; args: unknown[] }>);
vi.mock("ioredis", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeRedis extends EventEmitter {
    options: Record<string, unknown>;
    constructor(url: string, opts: Record<string, unknown> = {}) {
      super();
      this.options = { url, ...opts };
      constructed.push({ kind: "redis", args: [url, opts] });
    }
    disconnect() {}
    quit() {
      return Promise.resolve("OK");
    }
  }
  class FakeCluster extends EventEmitter {
    isCluster = true;
    startupNodes: unknown[];
    options: Record<string, unknown>;
    constructor(nodes: unknown[], opts: Record<string, unknown> = {}) {
      super();
      this.startupNodes = nodes;
      this.options = opts;
      constructed.push({ kind: "cluster", args: [nodes, opts] });
    }
    disconnect() {}
    quit() {
      return Promise.resolve("OK");
    }
  }
  return { Redis: FakeRedis, Cluster: FakeCluster, default: FakeRedis };
});

// Capture the original env so we can restore it
const originalEnv = { ...process.env };

const REDIS_ENV = [
  "REDIS_URL",
  "REDIS_MODE",
  "REDIS_PASSWORD",
  "REDIS_USERNAME",
  "REDIS_CA_CERT_PATH",
  "REDIS_TLS_REJECT_UNAUTHORIZED",
  "REDIS_TLS_MIN_VERSION",
  "REDIS_CLUSTER_NAT_MAP",
  "OPTIO_QUEUE_PREFIX",
];

type StandaloneOpts = { url: string; maxRetriesPerRequest: null; tls?: { minVersion?: string } };

describe("redis-config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(fs.readFileSync).mockReset();
    constructed.length = 0;
    for (const k of REDIS_ENV) delete process.env[k];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns plain URL with no TLS when REDIS_URL uses redis:// scheme", async () => {
    process.env.REDIS_URL = "redis://myhost:6379";
    const { redisConnectionUrl, redisTlsOptions, getBullMQConnectionOptions, redisMode } =
      await import("./redis-config.js");

    expect(redisMode).toBe("standalone");
    expect(redisConnectionUrl).toBe("redis://myhost:6379");
    expect(redisTlsOptions).toBeUndefined();

    const opts = getBullMQConnectionOptions() as StandaloneOpts;
    expect(opts.url).toBe("redis://myhost:6379");
    expect(opts.maxRetriesPerRequest).toBeNull();
    expect(opts.tls).toBeUndefined();
  });

  it("defaults to redis://localhost:6379 when REDIS_URL is not set", async () => {
    const { redisConnectionUrl, redisTlsOptions } = await import("./redis-config.js");

    expect(redisConnectionUrl).toBe("redis://localhost:6379");
    expect(redisTlsOptions).toBeUndefined();
  });

  it("enables TLS with minVersion TLSv1.3 when REDIS_URL uses rediss:// scheme", async () => {
    process.env.REDIS_URL = "rediss://secure-redis:6380";

    const { redisTlsOptions, getBullMQConnectionOptions } = await import("./redis-config.js");

    expect(redisTlsOptions).toBeDefined();
    expect(redisTlsOptions!.minVersion).toBe("TLSv1.3");
    expect(redisTlsOptions!.ca).toBeUndefined();
    expect(redisTlsOptions!.rejectUnauthorized).toBeUndefined();

    const opts = getBullMQConnectionOptions() as StandaloneOpts;
    expect(opts.tls).toEqual(redisTlsOptions);
  });

  it("lets REDIS_TLS_MIN_VERSION lower the floor to TLSv1.2 and rejects anything else", async () => {
    process.env.REDIS_URL = "rediss://secure-redis:6380";
    process.env.REDIS_TLS_MIN_VERSION = "TLSv1.2";
    const { redisTlsOptions } = await import("./redis-config.js");
    expect(redisTlsOptions!.minVersion).toBe("TLSv1.2");

    vi.resetModules();
    process.env.REDIS_TLS_MIN_VERSION = "TLSv1.0";
    await expect(import("./redis-config.js")).rejects.toThrow(/REDIS_TLS_MIN_VERSION/);
  });

  it("reads CA cert from file when REDIS_CA_CERT_PATH is set", async () => {
    process.env.REDIS_URL = "rediss://secure-redis:6380";
    process.env.REDIS_CA_CERT_PATH = "/etc/redis-tls/ca.crt";

    const mockCert = Buffer.from("-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----");
    vi.mocked(fs.readFileSync).mockReturnValue(mockCert);

    const { redisTlsOptions } = await import("./redis-config.js");

    expect(redisTlsOptions).toBeDefined();
    expect(redisTlsOptions!.ca).toEqual(mockCert);
    expect(redisTlsOptions!.minVersion).toBe("TLSv1.3");
    expect(fs.readFileSync).toHaveBeenCalledWith("/etc/redis-tls/ca.crt");
  });

  it("disables certificate verification when REDIS_TLS_REJECT_UNAUTHORIZED=false", async () => {
    process.env.REDIS_URL = "rediss://secure-redis:6380";
    process.env.REDIS_TLS_REJECT_UNAUTHORIZED = "false";

    const { redisTlsOptions } = await import("./redis-config.js");

    expect(redisTlsOptions).toBeDefined();
    expect(redisTlsOptions!.rejectUnauthorized).toBe(false);
  });

  it("getBullMQConnectionOptions always includes maxRetriesPerRequest: null", async () => {
    process.env.REDIS_URL = "redis://plain:6379";
    const { getBullMQConnectionOptions } = await import("./redis-config.js");
    const opts = getBullMQConnectionOptions() as StandaloneOpts;
    expect(opts.maxRetriesPerRequest).toBeNull();
  });

  it("keeps BullMQ's default prefix in standalone mode and takes OPTIO_QUEUE_PREFIX", async () => {
    process.env.REDIS_URL = "redis://plain:6379";
    const first = await import("./redis-config.js");
    expect(first.queuePrefix).toBe("bull");
    expect(first.getBullMQOptions()).toEqual({
      connection: first.getBullMQConnectionOptions(),
      prefix: "bull",
    });

    vi.resetModules();
    process.env.OPTIO_QUEUE_PREFIX = "{optio-staging}";
    const second = await import("./redis-config.js");
    expect(second.queuePrefix).toBe("{optio-staging}");
  });

  it("rejects a REDIS_URL node list without REDIS_MODE=cluster", async () => {
    process.env.REDIS_URL = "redis://a:6379,redis://b:6379";
    await expect(import("./redis-config.js")).rejects.toThrow(/REDIS_MODE=cluster/);
  });

  it("rejects an unknown REDIS_MODE", async () => {
    process.env.REDIS_MODE = "sentinel";
    await expect(import("./redis-config.js")).rejects.toThrow(/REDIS_MODE/);
  });

  describe("password injection", () => {
    it("injects REDIS_PASSWORD into URL when set", async () => {
      process.env.REDIS_URL = "redis://myhost:6379";
      process.env.REDIS_PASSWORD = "s3cret";
      const { redisConnectionUrl } = await import("./redis-config.js");
      expect(redisConnectionUrl).toBe("redis://:s3cret@myhost:6379");
    });

    it("injects password into rediss:// URL", async () => {
      process.env.REDIS_URL = "rediss://secure-redis:6380";
      process.env.REDIS_PASSWORD = "tls-pass";
      const { redisConnectionUrl } = await import("./redis-config.js");
      expect(redisConnectionUrl).toBe("rediss://:tls-pass@secure-redis:6380");
    });

    it("injects REDIS_USERNAME alongside the password (ACL users)", async () => {
      process.env.REDIS_URL = "rediss://cache.example:6379";
      process.env.REDIS_USERNAME = "optio";
      process.env.REDIS_PASSWORD = "pw";
      const { redisConnectionUrl } = await import("./redis-config.js");
      expect(redisConnectionUrl).toBe("rediss://optio:pw@cache.example:6379");
    });

    it("does not override password already present in URL", async () => {
      process.env.REDIS_URL = "redis://:existing@myhost:6379";
      process.env.REDIS_PASSWORD = "ignored";
      const { redisConnectionUrl } = await import("./redis-config.js");
      expect(redisConnectionUrl).toBe("redis://:existing@myhost:6379");
    });

    it("URL-encodes special characters in password", async () => {
      process.env.REDIS_URL = "redis://myhost:6379";
      process.env.REDIS_PASSWORD = "p@ss:word/test";
      const { redisConnectionUrl } = await import("./redis-config.js");
      // The URL should contain the encoded password
      expect(redisConnectionUrl).toContain("p%40ss%3Aword%2Ftest");
      expect(redisConnectionUrl).toContain("@myhost:6379");
    });

    it("does not inject password when REDIS_PASSWORD is empty", async () => {
      process.env.REDIS_URL = "redis://myhost:6379";
      process.env.REDIS_PASSWORD = "";
      const { redisConnectionUrl } = await import("./redis-config.js");
      expect(redisConnectionUrl).toBe("redis://myhost:6379");
    });
  });

  describe("cluster mode", () => {
    it("builds every client as an ioredis Cluster with TLS, auth and a hostname-preserving dnsLookup", async () => {
      process.env.REDIS_MODE = "cluster";
      process.env.REDIS_URL = "rediss://optio:pw@cache.serverless.example:6379";
      const mod = await import("./redis-config.js");

      expect(mod.redisMode).toBe("cluster");
      expect(mod.redisClusterNodes).toEqual([{ host: "cache.serverless.example", port: 6379 }]);
      expect(mod.queuePrefix).toBe("{optio}");
      expect(mod.describeRedisConfig()).toEqual({
        mode: "cluster",
        nodes: ["cache.serverless.example:6379"],
        tls: true,
        auth: true,
        queuePrefix: "{optio}",
      });

      const client = mod.createRedisClient({ connectionName: "test" }) as unknown as {
        isCluster: boolean;
        startupNodes: unknown[];
        options: {
          redisOptions: Record<string, unknown>;
          dnsLookup?: (a: string, cb: (e: null, r: string) => void) => void;
          lazyConnect: boolean;
        };
      };
      expect(client.isCluster).toBe(true);
      expect(mod.isClusterClient(client as never)).toBe(true);
      expect(client.startupNodes).toEqual([{ host: "cache.serverless.example", port: 6379 }]);
      expect(client.options.redisOptions).toMatchObject({
        username: "optio",
        password: "pw",
        connectionName: "test",
        maxRetriesPerRequest: null,
        tls: { minVersion: "TLSv1.3" },
      });
      // The certificate is for the hostname: CLUSTER SLOTS names stay as given.
      const seen: string[] = [];
      client.options.dnsLookup!("cache.serverless.example", (_e, r) => seen.push(r));
      expect(seen).toEqual(["cache.serverless.example"]);
    });

    it("shares ONE cluster instance across BullMQ queues and workers, with the hash-tagged prefix", async () => {
      process.env.REDIS_MODE = "cluster";
      process.env.REDIS_URL = "redis://a.example:7000,redis://b.example:7001";
      const mod = await import("./redis-config.js");

      expect(mod.redisClusterNodes).toEqual([
        { host: "a.example", port: 7000 },
        { host: "b.example", port: 7001 },
      ]);
      const one = mod.getBullMQOptions();
      const two = mod.getBullMQOptions();
      expect(one.prefix).toBe("{optio}");
      expect(one.connection).toBe(two.connection);
      expect((one.connection as { isCluster?: boolean }).isCluster).toBe(true);
      // No TLS → the default DNS lookup.
      expect(
        (one.connection as { options: { dnsLookup?: unknown } }).options.dnsLookup,
      ).toBeUndefined();

      await mod.closeSharedRedisClients();
      expect(mod.getBullMQOptions().connection).not.toBe(one.connection);
    });

    it("takes REDIS_PASSWORD / REDIS_USERNAME for every node", async () => {
      process.env.REDIS_MODE = "cluster";
      process.env.REDIS_URL = "rediss://a.example:7000,rediss://b.example:7001";
      process.env.REDIS_USERNAME = "svc";
      process.env.REDIS_PASSWORD = "p@ss";
      const mod = await import("./redis-config.js");
      const client = mod.createRedisClient() as unknown as {
        options: { redisOptions: Record<string, unknown> };
      };
      expect(client.options.redisOptions).toMatchObject({ username: "svc", password: "p@ss" });
      expect(mod.describeRedisConfig().auth).toBe(true);
    });

    it("insists on a hash tag in OPTIO_QUEUE_PREFIX", async () => {
      process.env.REDIS_MODE = "cluster";
      process.env.REDIS_URL = "redis://a.example:7000";
      process.env.OPTIO_QUEUE_PREFIX = "optio";
      await expect(import("./redis-config.js")).rejects.toThrow(/hash tag/);

      vi.resetModules();
      process.env.OPTIO_QUEUE_PREFIX = "{optio-prod}";
      const mod = await import("./redis-config.js");
      expect(mod.queuePrefix).toBe("{optio-prod}");
    });

    it("parses REDIS_CLUSTER_NAT_MAP", async () => {
      process.env.REDIS_MODE = "cluster";
      process.env.REDIS_URL = "redis://127.0.0.1:7000";
      process.env.REDIS_CLUSTER_NAT_MAP =
        "172.18.0.2:6379=127.0.0.1:7000, 172.18.0.3:6379=127.0.0.1:7001";
      const mod = await import("./redis-config.js");
      const client = mod.createRedisClient() as unknown as { options: { natMap: unknown } };
      expect(client.options.natMap).toEqual({
        "172.18.0.2:6379": { host: "127.0.0.1", port: 7000 },
        "172.18.0.3:6379": { host: "127.0.0.1", port: 7001 },
      });
    });

    it("rejects a node URL with a non-redis scheme", async () => {
      process.env.REDIS_MODE = "cluster";
      process.env.REDIS_URL = "http://a.example:7000";
      await expect(import("./redis-config.js")).rejects.toThrow(/redis:\/\/ or rediss:\/\//);
    });
  });

  describe("helpers", () => {
    it("hasHashTag follows Redis' first-non-empty-braces rule", async () => {
      const { hasHashTag } = await import("./redis-config.js");
      expect(hasHashTag("{optio}")).toBe(true);
      expect(hasHashTag("{optio}:tasks:wait")).toBe(true);
      expect(hasHashTag("optio")).toBe(false);
      expect(hasHashTag("{}optio")).toBe(false);
      expect(hasHashTag("{")).toBe(false);
    });

    it("redact drops credentials from a URL", async () => {
      const { redact } = await import("./redis-config.js");
      expect(redact("rediss://user:secret@host.example:6380")).toBe("rediss://host.example:6380");
      expect(redact("not a url with user:pw@x")).not.toContain("pw");
    });

    it("redisDeleteKeys issues one DEL per key on a cluster and batched DELs standalone", async () => {
      const { redisDeleteKeys } = await import("./redis-config.js");
      const calls: string[][] = [];
      const cluster = {
        isCluster: true,
        del: async (...keys: string[]) => {
          calls.push(keys);
          return keys.length;
        },
      };
      expect(await redisDeleteKeys(cluster as never, ["{a}1", "{b}2", "c3"])).toBe(3);
      expect(calls).toEqual([["{a}1"], ["{b}2"], ["c3"]]);

      calls.length = 0;
      const standalone = { del: cluster.del };
      expect(await redisDeleteKeys(standalone as never, ["a", "b"])).toBe(2);
      expect(calls).toEqual([["a", "b"]]);
      expect(await redisDeleteKeys(standalone as never, [])).toBe(0);
    });

    it("redisScanKeys scans every master of a cluster", async () => {
      const { redisScanKeys } = await import("./redis-config.js");
      const nodeWith = (keys: string[], host: string) => ({
        options: { host, port: 1 },
        scanStream: () => {
          const s = new EventEmitter();
          setImmediate(() => {
            s.emit("data", keys);
            s.emit("end");
          });
          return s;
        },
      });
      const cluster = {
        isCluster: true,
        status: "ready",
        nodes: (role: string) =>
          role === "master" ? [nodeWith(["a"], "n1"), nodeWith(["b", "c"], "n2")] : [],
      };
      expect((await redisScanKeys(cluster as never, "*")).sort()).toEqual(["a", "b", "c"]);
      const solo = { ...nodeWith(["x"], "solo"), status: "ready" };
      expect(await redisScanKeys(solo as never, "*")).toEqual(["x"]);
    });

    it("waits for a connecting cluster client before fanning out per node", async () => {
      const { inspectRedisEviction } = await import("./redis-config.js");
      const { EventEmitter } = await import("node:events");
      const client = Object.assign(new EventEmitter(), {
        isCluster: true,
        status: "connecting",
        nodes: () => [
          { options: { host: "a", port: 1 }, info: async () => "maxmemory_policy:noeviction\n" },
        ],
      });
      const pending = inspectRedisEviction(client as never);
      let settled = false;
      void pending.then(() => (settled = true));
      await new Promise((r) => setImmediate(r));
      expect(settled).toBe(false);
      client.status = "ready";
      client.emit("ready");
      expect((await pending).map((r) => r.policy)).toEqual(["noeviction"]);
    });

    it("inspectRedisEviction reads each node's policy and reports an absent one as null", async () => {
      const { inspectRedisEviction } = await import("./redis-config.js");
      const node = (host: string, info: string) => ({
        options: { host, port: 6379 },
        info: async () => info,
      });
      const cluster = {
        isCluster: true,
        status: "ready",
        nodes: () => [
          node(
            "a",
            "# Memory\r\nused_memory:1024\r\nmaxmemory:0\r\nmaxmemory_policy:noeviction\r\n",
          ),
          node("b", "# Memory\r\nused_memory:2048\r\n"),
        ],
      };
      expect(await inspectRedisEviction(cluster as never)).toEqual([
        { node: "a:6379", policy: "noeviction", maxmemory: 0, usedMemory: 1024 },
        { node: "b:6379", policy: null, maxmemory: null, usedMemory: 2048 },
      ]);
    });
  });
});
