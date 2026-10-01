/**
 * E2E: a Job with no agent — a terminal that exits, in the work attributes'
 * terms — runs its prompt as a shell command in a pod. Created through
 * POST /api/work with `who.runtime: null`; the worker runs `$OPTIO_COMMAND`,
 * logs each output line, and settles the run on the command's exit status
 * (the fake runtime plays the command; `[[mock:fail]]` exits 1).
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

interface Run {
  id: string;
  state: string;
  errorMessage: string | null;
  prompt: string | null;
  agentType: string | null;
}

async function startCommand(name: string, command: string) {
  const { status, body } = await api<{ id: string; kind: string; run?: { id: string } }>(
    "/api/work",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        when: { type: "manual" },
        where: { runTarget: "cluster" },
        who: { runtime: null },
        what: { prompt: command },
        then: "exits",
      }),
    },
  );
  expect(status).toBe(201);
  expect(body.kind).toBe("standalone");
  return { jobId: body.id, runId: body.run!.id };
}

function settled(runId: string): Promise<Run> {
  return waitFor(
    async () => {
      const { body } = await api<{ run: Run }>(`/api/workflow-runs/${runId}`);
      return ["completed", "failed"].includes(body.run.state) ? body.run : null;
    },
    { timeoutMs: 90_000, label: `command run ${runId} settles` },
  );
}

describe("command Job e2e", () => {
  it("runs the command, logs its output, and completes on exit 0", async () => {
    const { jobId, runId } = await startCommand("e2e command job", "echo hello && date");
    const run = await settled(runId);
    expect(run.state).toBe("completed");
    // The run records what it ran, and that no agent ran it.
    expect(run.prompt).toBe("echo hello && date");
    expect(run.agentType).toBeNull();

    const { body: logs } = await api<{ logs: Array<{ content: string }> }>(
      `/api/workflow-runs/${runId}/logs`,
    );
    const lines = logs.logs.map((l) => l.content);
    expect(lines).toContain("fake command output");
    // The exit status line is read, not logged.
    expect(lines.some((l) => l.startsWith("[optio:exit]"))).toBe(false);

    // The legacy Job shape says it runs a shell, and the Work list says it's a terminal.
    const { body: job } = await api<{ workflow: { agentRuntime: string } }>(`/api/jobs/${jobId}`);
    expect(job.workflow.agentRuntime).toBe("shell");
    const { body: work } = await api<{ row: { who: string } }>(`/api/work/${jobId}`);
    expect(work.row.who).toBe("terminal");
  });

  it("fails the run with the command's exit status", async () => {
    const { runId } = await startCommand("e2e failing command", "exit 1 # [[mock:fail]]");
    const run = await settled(runId);
    expect(run.state).toBe("failed");
    expect(run.errorMessage).toMatch(/exited with status 1/);
  });

  it("refuses a command Job with nothing to run", async () => {
    const { status, body } = await api<{ error: string }>("/api/work", {
      method: "POST",
      body: JSON.stringify({
        name: "e2e empty command",
        when: { type: "manual" },
        where: { runTarget: "cluster" },
        who: { runtime: null },
        what: { prompt: "  " },
        then: "exits",
      }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/needs a command/);
  });
});
