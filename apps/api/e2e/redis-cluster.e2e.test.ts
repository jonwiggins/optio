/**
 * E2E: the REAL API server on a REAL Redis Cluster (REDIS_MODE=cluster).
 *
 * Boots the whole server — migrations, all workers, pub/sub, the rate
 * limiter — against the three-master cluster scripts/test-infra.sh starts,
 * with a hash-tagged BullMQ prefix unique to this file, and drives Optio's
 * own queues through it: a Job run enqueued → executed → completed with its
 * logs streamed over the Redis pub/sub hop; a failing run retried by the
 * reconciler; a schedule trigger (delayed, recurring work) firing a run; a
 * running job cancelled; and a reconnect — every connection the cluster
 * holds killed while the server runs, after which runs still complete and
 * log streams still arrive.
 *
 * Skips itself when the test cluster is unreachable. Run this tier and the
 * integration tier one after the other, not at once: the integration cluster
 * test kills every connection on the same test cluster, this server's too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cluster } from "ioredis";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";
import {
  clusterTestPrefix,
  testRedisClusterReachable,
  testRedisClusterUrl,
} from "../src/test-utils/redis-cluster.js";

const clusterUp = await testRedisClusterReachable();
if (!clusterUp) {
  console.warn(
    "[redis-cluster.e2e] test Redis Cluster unreachable (bash scripts/test-infra.sh start) — skipping",
  );
}

const prefix = clusterTestPrefix("e2e");
let server: ApiServerHandle;
let admin: Cluster;
const openSockets: WebSocket[] = [];

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  // A JSON content-type on a bodiless request (DELETE, an empty POST) is a 400.
  const res = await fetch(`${server.baseUrl}${path}`, {
    ...(init?.body ? { headers: { "content-type": "application/json" } } : {}),
    ...init,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

interface Run {
  id: string;
  state: string;
  costUsd: string | null;
  errorMessage?: string | null;
  retryCount?: number;
  triggerId?: string | null;
}
interface RunBody {
  run: Run;
}

async function createJob(
  name: string,
  promptTemplate: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const { status, body } = await api<{ workflow: { id: string } }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ name, promptTemplate, agentRuntime: "claude-code", ...extra }),
  });
  expect(status).toBe(201);
  return body.workflow.id;
}

async function startRun(workflowId: string): Promise<string> {
  const { status, body } = await api<RunBody>(`/api/jobs/${workflowId}/runs`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  expect(status).toBe(201);
  return body.run.id;
}

async function waitForRunState(runId: string, states: string[], timeoutMs = 90_000): Promise<Run> {
  return waitFor(
    async () => {
      const { body } = await api<RunBody>(`/api/workflow-runs/${runId}`);
      return states.includes(body.run.state) ? body.run : null;
    },
    { timeoutMs, label: `run ${runId} → ${states.join("|")}\nserver logs:\n${server.logs()}` },
  );
}

function connectLogStream(runId: string): { frames: Array<Record<string, unknown>> } {
  const ws = new WebSocket(
    `${server.baseUrl.replace("http", "ws")}/ws/workflow-runs/${runId}/logs`,
  );
  openSockets.push(ws);
  const frames: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (ev) => {
    try {
      frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    } catch {
      // the server only sends JSON
    }
  });
  return { frames };
}

/** Every key this server wrote under its queue prefix, across the masters. */
async function prefixedKeys(): Promise<string[]> {
  const out: string[] = [];
  for (const node of admin.nodes("master")) {
    const stream = node.scanStream({ match: `${prefix}*`, count: 200 });
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (keys: string[]) => out.push(...keys));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  }
  return out;
}

/** Drop every connection except the admin's own (CLIENT KILL skips the caller). */
async function killAllConnections(): Promise<void> {
  for (const node of admin.nodes("master")) {
    await node.client("KILL", "TYPE", "normal");
    await node.client("KILL", "TYPE", "pubsub");
  }
}

describe.skipIf(!clusterUp)("Redis Cluster e2e", () => {
  beforeAll(async () => {
    admin = new Cluster(
      testRedisClusterUrl()
        .split(",")
        .map((u) => {
          const url = new URL(u.trim());
          return { host: url.hostname, port: Number(url.port || 6379) };
        }),
    );
    admin.on("error", () => {});
    await waitFor(async () => (await admin.ping().catch(() => "")) === "PONG", {
      timeoutMs: 15_000,
    });

    server = await startApiServer({
      logLevel: "info",
      env: {
        REDIS_MODE: "cluster",
        REDIS_URL: testRedisClusterUrl(),
        OPTIO_QUEUE_PREFIX: prefix,
      },
    });
  }, 150_000);

  afterAll(async () => {
    for (const ws of openSockets) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
    await server?.stop();
    // The server's queues are this file's alone: remove every key it left.
    if (admin) {
      for (const key of await prefixedKeys()) await admin.del(key).catch(() => {});
      admin.disconnect();
    }
  }, 60_000);

  it("boots in cluster mode and reports the Redis configuration", async () => {
    const { status } = await api("/api/health");
    expect(status).toBe(200);
    // pino-pretty in dev (`mode: "cluster"`, with colour codes before the
    // colon), JSON in production (`"mode":"cluster"`): match both.
    // The pretty-printing log transport lags the process a little: poll.
    const logs = await waitFor(
      async () => (/Redis connected/.test(server.logs()) ? server.logs() : null),
      { timeoutMs: 15_000, label: `Redis connected in the boot log\n${server.logs()}` },
    );
    const tail = logs.split("\n").slice(-40).join("\n");
    expect(logs, tail).toMatch(/mode\S*:\s?"cluster"/);
    expect(logs, tail).toMatch(
      new RegExp(`queuePrefix\\S*:\\s?"${prefix.replace(/[{}]/g, "\\$&")}"`),
    );
    expect(logs).not.toMatch(/CROSSSLOT/);
  });

  it("runs a Job to completion, its keys under the hash-tagged prefix and nothing under bull:", async () => {
    const workflowId = await createJob("cluster success job", "Say hello from the mock agent");
    const runId = await startRun(workflowId);
    const run = await waitForRunState(runId, ["completed", "failed"]);
    expect(run.state).toBe("completed");
    expect(run.costUsd).toBe("0.0123");

    const { body: logsBody } = await api<{ logs: Array<{ content: string }> }>(
      `/api/workflow-runs/${runId}/logs`,
    );
    expect(logsBody.logs.map((l) => l.content).join("\n")).toContain("Mock agent handled");

    // Every queue the server registered at boot lives under the same tag. The
    // repeatable jobs are registered as the workers start, so give a loaded
    // machine a moment.
    const bootQueues = [
      "workflow-runs",
      "tasks",
      "pr-watcher",
      "reconcile-resync",
      "workflow-trigger-checker",
    ];
    const keys = await waitFor(
      async () => {
        const all = await prefixedKeys();
        const missing = bootQueues.filter((q) => !all.some((k) => k.startsWith(`${prefix}:${q}:`)));
        return missing.length === 0 ? all : null;
      },
      { timeoutMs: 20_000, label: `keys of ${bootQueues.join(", ")} under ${prefix}` },
    );
    expect(keys.every((k) => k.startsWith(prefix))).toBe(true);
    expect(server.logs()).not.toMatch(/CROSSSLOT/);
  });

  it("retries a failing run through the reconciler before giving up", async () => {
    const workflowId = await createJob("cluster retry job", "Break things [[mock:fail]]", {
      maxRetries: 1,
    });
    const runId = await startRun(workflowId);
    const run = await waitFor(
      async () => {
        const { body } = await api<RunBody>(`/api/workflow-runs/${runId}`);
        return body.run.state === "failed" && (body.run.retryCount ?? 0) >= 1 ? body.run : null;
      },
      { timeoutMs: 120_000, label: `run ${runId} failed after a retry\n${server.logs()}` },
    );
    expect(run.retryCount).toBe(1);
  });

  it("fires a schedule trigger (recurring, delayed work) into a run", async () => {
    const workflowId = await createJob("cluster scheduled job", "Tick from the mock agent");
    const { status, body } = await api<{ trigger: { id: string } }>(
      `/api/tasks/${workflowId}/triggers`,
      {
        method: "POST",
        body: JSON.stringify({ type: "schedule", config: { cronExpression: "*/2 * * * * *" } }),
      },
    );
    expect(status).toBe(201);
    const triggerId = body.trigger.id;

    const run = await waitFor(
      async () => {
        const { body: runs } = await api<{ runs: Run[] }>(`/api/jobs/${workflowId}/runs`);
        return runs.runs.find((r) => r.triggerId === triggerId) ?? null;
      },
      { timeoutMs: 60_000, label: `schedule trigger ${triggerId} fired\n${server.logs()}` },
    );
    await api(`/api/tasks/${workflowId}/triggers/${triggerId}`, { method: "DELETE" });
    const finished = await waitForRunState(run.id, ["completed", "failed"]);
    expect(finished.state).toBe("completed");
  });

  it('cancels a running job (recorded as failed, "Cancelled by user")', async () => {
    const workflowId = await createJob("cluster cancel job", "Linger [[mock:sleep:60000]]", {
      maxRetries: 0,
    });
    const runId = await startRun(workflowId);
    await waitForRunState(runId, ["running"]);
    const { status, body } = await api(`/api/workflow-runs/${runId}/cancel`, {
      method: "POST",
      body: "{}",
    });
    expect(status, JSON.stringify(body)).toBe(200);
    const run = await waitForRunState(runId, ["cancelled", "failed", "completed"], 60_000);
    expect(run.state).toBe("failed");
    expect(run.errorMessage).toBe("Cancelled by user");
  });

  it("recovers when every connection is killed: runs still complete and logs still stream", async () => {
    await killAllConnections();

    const workflowId = await createJob("cluster reconnect job", "Still here [[mock:sleep:4000]]", {
      maxRetries: 0,
    });
    const runId = await startRun(workflowId);
    await waitForRunState(runId, ["running"]);
    const stream = connectLogStream(runId);

    const run = await waitForRunState(runId, ["completed", "failed"]);
    expect(run.state).toBe("completed");
    // The state change rode the pub/sub hop on a subscriber opened AFTER the kill
    await waitFor(
      async () =>
        stream.frames.find(
          (f) => f.type === "workflow_run:state_changed" && f.toState === "completed",
        ) ?? null,
      { timeoutMs: 30_000, label: "completed frame over the reconnected pub/sub" },
    );

    // And a subscriber that existed BEFORE a kill re-arms: open one, kill again, publish.
    const second = await startRun(
      await createJob("cluster re-arm job", "Again [[mock:sleep:4000]]", { maxRetries: 0 }),
    );
    await waitForRunState(second, ["running"]);
    const rearmed = connectLogStream(second);
    await waitFor(async () => (rearmed.frames.length > 0 ? true : null), { timeoutMs: 30_000 });
    await killAllConnections();
    await waitForRunState(second, ["completed", "failed"]);
    await waitFor(
      async () =>
        rearmed.frames.find(
          (f) => f.type === "workflow_run:state_changed" && f.toState === "completed",
        ) ?? null,
      { timeoutMs: 30_000, label: "completed frame after the subscriber reconnected" },
    );
    expect(server.logs()).not.toMatch(/CROSSSLOT/);
  });
});
