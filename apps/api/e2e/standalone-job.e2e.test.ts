/**
 * E2E: standalone Job (workflow) lifecycle through the real API server.
 *
 * Covers: POST /api/jobs → POST /api/jobs/:id/runs → BullMQ workflow-worker
 * picks it up → fake pod exec → claude NDJSON stream parsed → logs persisted
 * → run completes with cost. Also the failure path via the [[mock:fail]]
 * directive.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;

beforeAll(async () => {
  server = await startApiServer();
}, 150_000);

afterAll(async () => {
  await server?.stop();
});

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface RunBody {
  run: { id: string; state: string; costUsd: string | null; errorMessage: string | null };
}

async function createJob(name: string, promptTemplate: string): Promise<string> {
  const { status, body } = await api<{ workflow: { id: string } }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ name, promptTemplate, agentRuntime: "claude-code" }),
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
  expect(body.run.state).toBe("queued");
  return body.run.id;
}

async function waitForRunState(runId: string, states: string[]): Promise<RunBody["run"]> {
  return waitFor(
    async () => {
      const { body } = await api<RunBody>(`/api/workflow-runs/${runId}`);
      return states.includes(body.run.state) ? body.run : null;
    },
    { timeoutMs: 90_000, label: `run ${runId} → ${states.join("|")} \nserver logs:\n` },
  );
}

describe("standalone job e2e", () => {
  it("runs a job to completion with logs and cost recorded", async () => {
    const workflowId = await createJob("e2e success job", "Say hello from the mock agent");
    const runId = await startRun(workflowId);

    const run = await waitForRunState(runId, ["completed", "failed"]);
    expect(run.state).toBe("completed");
    expect(run.costUsd).toBe("0.0123");

    const { body: logsBody } = await api<{ logs: Array<{ content: string; logType: string }> }>(
      `/api/workflow-runs/${runId}/logs`,
    );
    const contents = logsBody.logs.map((l) => l.content).join("\n");
    expect(contents).toContain("Mock agent handled");
    expect(logsBody.logs.some((l) => l.logType === "system")).toBe(true);
  });

  it("marks a run failed when the agent reports an error", async () => {
    // maxRetries: 0 keeps the reconciler from re-queueing the failed run.
    const { status, body } = await api<{ workflow: { id: string } }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "e2e failing job",
        promptTemplate: "Break things [[mock:fail]]",
        agentRuntime: "claude-code",
        maxRetries: 0,
      }),
    });
    expect(status).toBe(201);

    const runId = await startRun(body.workflow.id);
    const run = await waitForRunState(runId, ["failed"]);
    expect(run.state).toBe("failed");
  });
});
