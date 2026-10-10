/**
 * E2E: two real API servers on one database (the scale-out harness,
 * src/test-utils/e2e/api-cluster.ts). Both boot (migrations under the
 * advisory lock, workers registered twice), work made through one is read
 * through the other, a run completes with both taking BullMQ jobs, and one
 * server's SIGKILL leaves the other serving and starting new runs.
 *
 * The runs here still go through the classic exec path (the workers move to
 * the run protocol in phase B); the fake runtime keeps its pods on disk
 * under the cluster's directory, which both servers read.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startApiCluster, type ApiCluster } from "../src/test-utils/e2e/api-cluster.js";
import { waitFor } from "../src/test-utils/e2e/api-server.js";

let cluster: ApiCluster;

beforeAll(async () => {
  cluster = await startApiCluster({ size: 2 });
}, 240_000);

afterAll(async () => {
  await cluster?.stop();
});

interface RunBody {
  run: { id: string; state: string; costUsd: string | null; errorMessage: string | null };
}

async function createJob(i: number, name: string): Promise<string> {
  const { status, body } = await cluster.client(i)<{ workflow: { id: string } }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      name,
      promptTemplate: "Say hello from the cluster",
      agentRuntime: "claude-code",
    }),
  });
  expect(status).toBe(201);
  return body.workflow.id;
}

async function startRun(i: number, workflowId: string): Promise<string> {
  const { status, body } = await cluster.client(i)<RunBody>(`/api/jobs/${workflowId}/runs`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  expect(status).toBe(201);
  return body.run.id;
}

async function waitForRun(i: number, runId: string, states: string[]): Promise<RunBody["run"]> {
  return waitFor(
    async () => {
      const { body } = await cluster.client(i)<RunBody>(`/api/workflow-runs/${runId}`);
      return states.includes(body.run.state) ? body.run : null;
    },
    { timeoutMs: 90_000, label: `run ${runId} → ${states.join("|")}` },
  );
}

describe("api cluster e2e", () => {
  it("both servers are healthy and each reports its own instance", async () => {
    const [a, b] = await Promise.all([
      cluster.client(0)<{ healthy: boolean; instanceId?: string }>("/api/health"),
      cluster.client(1)<{ healthy: boolean; instanceId?: string }>("/api/health"),
    ]);
    expect(a.body.healthy).toBe(true);
    expect(b.body.healthy).toBe(true);
    expect(a.body.instanceId).toMatch(/^api-0:[0-9a-f]{6}$/);
    expect(b.body.instanceId).toMatch(/^api-1:[0-9a-f]{6}$/);
  });

  it("a Job created through A is read through B, and its run completes", async () => {
    const workflowId = await createJob(0, "cluster job");
    const { status, body } = await cluster.client(1)<{ workflow: { id: string; name: string } }>(
      `/api/jobs/${workflowId}`,
    );
    expect(status).toBe(200);
    expect(body.workflow.name).toBe("cluster job");

    const runId = await startRun(0, workflowId);
    const run = await waitForRun(1, runId, ["completed", "failed"]);
    expect(run.state).toBe("completed");
    expect(run.costUsd).toBe("0.0123");
    // The fake kept its pod on disk, where both servers look.
    expect(existsSync(join(cluster.fakeRuntimeDir, "containers"))).toBe(true);
    expect(readdirSync(join(cluster.fakeRuntimeDir, "containers")).length).toBeGreaterThan(0);
  });

  it("after A is SIGKILLed, B keeps serving and runs new work", async () => {
    await cluster.kill(0, "SIGKILL");
    expect(cluster.live().map((s) => s.name)).toEqual(["api-1"]);
    await expect(cluster.client(0)("/api/health")).rejects.toThrow(/killed/);

    const workflowId = await createJob(1, "after the kill");
    const runId = await startRun(1, workflowId);
    const run = await waitForRun(1, runId, ["completed", "failed"]);
    expect(run.state).toBe("completed");

    const { body } = await cluster.any()<{ healthy: boolean; instanceId?: string }>("/api/health");
    expect(body.instanceId).toMatch(/^api-1:/);
  });

  it("a third server joins the same database and work", async () => {
    const c = await cluster.add();
    expect(c.name).toBe("api-2");
    const { body } = await cluster.client(2)<{ workflows: Array<{ name: string }> }>("/api/jobs");
    expect(body.workflows.map((w) => w.name)).toEqual(
      expect.arrayContaining(["cluster job", "after the kill"]),
    );
  }, 150_000);
});
