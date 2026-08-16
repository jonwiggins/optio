/**
 * E2E: cursor agent runtime through the real API server.
 *
 * Cursor's stream-json output is claude-shaped, so the fake container runtime
 * plays cursor-agent execs with its standard tape (reading the prompt from
 * OPTIO_PROMPT instead of stdin — cursor passes it positionally). This covers:
 * the cursor branch of buildWorkflowAgentCommand, CURSOR_API_KEY secret
 * resolution, the cursor event parser (session capture + log entries), and
 * run completion.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;

beforeAll(async () => {
  server = await startApiServer();
  // The cursor adapter requires CURSOR_API_KEY; a dummy value satisfies
  // secret resolution under the fake runtime.
  const res = await fetch(`${server.baseUrl}/api/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "CURSOR_API_KEY", value: "key_e2e_dummy" }),
  });
  expect([200, 201]).toContain(res.status);
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
  run: { id: string; state: string; errorMessage: string | null; sessionId?: string | null };
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

describe("cursor agent e2e", () => {
  it("runs a standalone job on the cursor runtime to completion", async () => {
    const { status, body } = await api<{ workflow: { id: string } }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "e2e cursor job",
        promptTemplate: "Say hello from the mock cursor agent",
        agentRuntime: "cursor",
      }),
    });
    expect(status).toBe(201);

    const { status: runStatus, body: runBody } = await api<RunBody>(
      `/api/jobs/${body.workflow.id}/runs`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(runStatus).toBe(201);

    const run = await waitForRunState(runBody.run.id, ["completed", "failed"]);
    expect(run.errorMessage).toBeNull();
    expect(run.state).toBe("completed");

    const { body: logsBody } = await api<{ logs: Array<{ content: string; logType: string }> }>(
      `/api/workflow-runs/${runBody.run.id}/logs`,
    );
    const contents = logsBody.logs.map((l) => l.content).join("\n");
    // The assistant message came through the cursor event parser
    expect(contents).toContain("Mock agent handled");
    // The init event was rendered as a system entry (session captured)
    expect(logsBody.logs.some((l) => l.logType === "system")).toBe(true);
  });

  it("fails a cursor run when the agent reports an error", async () => {
    const { body } = await api<{ workflow: { id: string } }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "e2e cursor failing job",
        promptTemplate: "Break things [[mock:fail]]",
        agentRuntime: "cursor",
        maxRetries: 0,
      }),
    });

    const { body: runBody } = await api<RunBody>(`/api/jobs/${body.workflow.id}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    const run = await waitForRunState(runBody.run.id, ["failed"]);
    expect(run.state).toBe("failed");
  });
});
