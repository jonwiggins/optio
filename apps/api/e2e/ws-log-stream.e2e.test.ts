/**
 * E2E: live WebSocket log streaming for standalone Job (workflow) runs.
 *
 * Route under test: GET /ws/workflow-runs/:workflowRunId/logs
 * (apps/api/src/ws/workflow-run-log-stream.ts). On connect the server sends a
 * catch-up of persisted logs (each frame flagged `catchUp: true`), then
 * subscribes to the Redis channel `optio:workflow-run:<id>` and forwards live
 * `workflow_run:log` and `workflow_run:state_changed` events verbatim (no
 * catchUp flag).
 *
 * Covers:
 *  - connecting mid-run ([[mock:sleep:15000]] keeps the fake agent busy) and
 *    receiving catch-up frames, a live log frame with the agent's output, and
 *    the state_changed frame for running → completed
 *  - a late join after completion: catch-up alone carries the full history
 *  - unknown run id → socket closed with code 4404
 *
 * Uses Node's global WebSocket client (available since Node 22).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;
const openSockets: WebSocket[] = [];

beforeAll(async () => {
  server = await startApiServer();
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

interface LogsBody {
  logs: Array<{ content: string; logType: string | null; timestamp: string }>;
}

/** Frame shapes sent by workflow-run-log-stream.ts (catch-up + forwarded events). */
interface StreamFrame {
  type: string;
  workflowRunId?: string;
  content?: string;
  stream?: string;
  timestamp?: string;
  logType?: string;
  metadata?: unknown;
  catchUp?: boolean;
  // workflow_run:state_changed fields
  workflowId?: string;
  fromState?: string;
  toState?: string;
}

interface LogSocket {
  ws: WebSocket;
  frames: StreamFrame[];
  closed: Promise<{ code: number; reason: string }>;
}

function connectLogStream(runId: string): LogSocket {
  const wsUrl = `${server.baseUrl.replace("http", "ws")}/ws/workflow-runs/${runId}/logs`;
  const ws = new WebSocket(wsUrl);
  openSockets.push(ws);

  const frames: StreamFrame[] = [];
  ws.addEventListener("message", (ev) => {
    try {
      frames.push(JSON.parse(String(ev.data)) as StreamFrame);
    } catch {
      // non-JSON frame — the server only sends JSON, so ignore
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason }));
  });
  return { ws, frames, closed };
}

async function createJob(name: string, promptTemplate: string): Promise<string> {
  const { status, body } = await api<{ workflow: { id: string } }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ name, promptTemplate, agentRuntime: "claude-code", maxRetries: 0 }),
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

describe("workflow run WebSocket log stream e2e", () => {
  it("streams catch-up, live logs, and the completed state change while a run executes", async () => {
    const workflowId = await createJob("ws live stream job", "Stream me live [[mock:sleep:15000]]");
    const runId = await startRun(workflowId);

    // Wait until the run is RUNNING and its first log (the session-init system
    // entry) is persisted. The fake agent then sleeps 15s before emitting the
    // assistant text + result, which is the window for the WS to attach mid-run.
    await waitFor(
      async () => {
        const { body } = await api<RunBody>(`/api/workflow-runs/${runId}`);
        if (body.run.state !== "running") return null;
        const { body: logsBody } = await api<LogsBody>(`/api/workflow-runs/${runId}/logs`);
        return logsBody.logs.length > 0 ? true : null;
      },
      { timeoutMs: 60_000, intervalMs: 100, label: `run ${runId} running with first log` },
    );

    const conn = connectLogStream(runId);
    try {
      const completedFrame = await waitFor(
        async () =>
          conn.frames.find(
            (f) => f.type === "workflow_run:state_changed" && f.toState === "completed",
          ) ?? null,
        { timeoutMs: 60_000, intervalMs: 100, label: "state_changed → completed frame" },
      );

      // State-change frame: forwarded verbatim from the worker's transitionRun.
      expect(completedFrame.workflowRunId).toBe(runId);
      expect(completedFrame.workflowId).toBe(workflowId);
      expect(completedFrame.fromState).toBe("running");
      expect(completedFrame.catchUp).toBeUndefined();

      // Catch-up frames arrive first and are flagged catchUp: true.
      expect(conn.frames.length).toBeGreaterThan(0);
      expect(conn.frames[0].type).toBe("workflow_run:log");
      expect(conn.frames[0].catchUp).toBe(true);
      const catchUpFrames = conn.frames.filter((f) => f.catchUp === true);
      expect(catchUpFrames.length).toBeGreaterThan(0);
      // The session-init system log was persisted before we connected, so it
      // must be part of catch-up.
      expect(catchUpFrames.some((f) => f.content?.includes("Session started"))).toBe(true);
      expect(catchUpFrames.every((f) => f.type === "workflow_run:log")).toBe(true);
      expect(catchUpFrames.every((f) => f.workflowRunId === runId)).toBe(true);

      // The mock agent's assistant text was emitted AFTER we connected (during
      // the 15s sleep), so it must arrive as a LIVE frame — no catchUp flag.
      const liveLogs = conn.frames.filter(
        (f) => f.type === "workflow_run:log" && f.catchUp === undefined,
      );
      const liveText = liveLogs.find((f) => f.content?.includes("Mock agent handled"));
      expect(liveText).toBeDefined();
      expect(liveText?.logType).toBe("text");
      expect(liveText?.workflowRunId).toBe(runId);
      expect(liveText?.stream).toBe("stdout");
      // ...and must NOT have been in the catch-up (it did not exist yet).
      expect(catchUpFrames.some((f) => f.content?.includes("Mock agent handled"))).toBe(false);
    } finally {
      conn.ws.close();
    }
  });

  it("delivers the full log history as catch-up to a socket joining after completion", async () => {
    const workflowId = await createJob("ws late join job", "Late join says hi");
    const runId = await startRun(workflowId);

    const run = await waitFor(
      async () => {
        const { body } = await api<RunBody>(`/api/workflow-runs/${runId}`);
        return ["completed", "failed"].includes(body.run.state) ? body.run : null;
      },
      { timeoutMs: 90_000, intervalMs: 300, label: `run ${runId} terminal` },
    );
    expect(run.state).toBe("completed");

    // Historical logs via HTTP are the source of truth for what catch-up owes us.
    const { body: logsBody } = await api<LogsBody>(`/api/workflow-runs/${runId}/logs`);
    const expectedContents = logsBody.logs.map((l) => l.content);
    expect(expectedContents.length).toBeGreaterThan(0);

    const conn = connectLogStream(runId);
    try {
      await waitFor(async () => (conn.frames.length >= expectedContents.length ? true : null), {
        timeoutMs: 30_000,
        intervalMs: 50,
        label: `late-join catch-up of ${expectedContents.length} frames`,
      });

      // Catch-up only — the run is terminal, so no live events exist.
      expect(conn.frames.length).toBe(expectedContents.length);
      expect(conn.frames.every((f) => f.type === "workflow_run:log")).toBe(true);
      expect(conn.frames.every((f) => f.catchUp === true)).toBe(true);
      expect(conn.frames.every((f) => f.workflowRunId === runId)).toBe(true);

      // Same rows as the HTTP history (order-insensitive compare: rows written
      // in the same millisecond have no defined order between the two queries).
      const received = conn.frames.map((f) => f.content ?? "").sort();
      expect(received).toEqual([...expectedContents].sort());

      const joined = expectedContents.join("\n");
      expect(joined).toContain("Session started");
      expect(joined).toContain("Mock agent handled");
    } finally {
      conn.ws.close();
    }
  });

  it("closes the socket with 4404 for an unknown workflow run id", async () => {
    const conn = connectLogStream(randomUUID());
    const { code, reason } = await conn.closed;
    expect(code).toBe(4404);
    expect(reason).toBe("Workflow run not found");
    expect(conn.frames).toHaveLength(0);
  });
});
