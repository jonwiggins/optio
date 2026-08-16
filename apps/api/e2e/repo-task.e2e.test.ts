/**
 * E2E: repo-task pipeline through the real API server with the fake runtime.
 *
 * Covers: POST /api/repos + POST /api/tasks → BullMQ task-worker → fake repo
 * pod (OPTIO_RUNTIME=fake) → claude NDJSON stream parsed → logs/cost/PR
 * persisted → terminal classification:
 *   - [[mock:pr]]     → pr_opened (`pr_detected`), prUrl on the task's repo
 *   - plain success   → needs_attention (`completed_without_pr`)
 *   - [[mock:fail]]   → failed (`agent_failure`) — terminal, no auto-retry
 *   - [[mock:silent]] → failed (`agent_no_output`)
 *
 * Directive delivery: for repo tasks the agent's stdin prompt is the rendered
 * DEFAULT_PROMPT_TEMPLATE, which does not embed the raw task prompt inline.
 * Two routes still reach the fake: (a) the raw prompt travels in the task
 * FILE, base64-encoded inside the exec script, which the fake decodes and
 * scans for directives; (b) {{TASK_TITLE}} is rendered into the template, so
 * directives in the task TITLE also work — this file uses route (b).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

const REPO_URL = "https://github.com/e2e-org/e2e-repo";
const REPO_FULL_NAME = "e2e-org/e2e-repo";

let server: ApiServerHandle;
let shimDir: string;

beforeAll(async () => {
  // The bare-pod provisioning path (OPTIO_STATEFULSET_ENABLED=false) shells
  // out to real `kubectl` for a home PVC (`kubectl get pvc` / `kubectl apply`,
  // tolerated on failure). Prepend a failing shim so a live local cluster is
  // never touched — the pod then uses "ephemeral storage", same as a machine
  // with no cluster.
  shimDir = mkdtempSync(join(tmpdir(), "optio-e2e-kubectl-"));
  writeFileSync(join(shimDir, "kubectl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  server = await startApiServer({
    env: {
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      // The dummy GITHUB_TOKEN below makes git-platform lookups succeed, so
      // the PR watcher would poll api.github.com every 2s with an invalid
      // token while a task sits in pr_opened. Every failure is caught (the
      // task stays in pr_opened), but slow the watcher anyway — it plays no
      // part in these scenarios.
      OPTIO_PR_WATCH_INTERVAL: "600000",
    },
  });

  // The task-worker's secret resolution hard-requires ANTHROPIC_API_KEY (the
  // default claude auth mode is api-key) and GITHUB_TOKEN (no GitHub App is
  // configured) — provisioning fails without them. Seed dummies the way the
  // setup wizard would; the fake runtime never uses the values. The route's
  // validation probes are best-effort and do not gate the 201.
  for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
    const secretRes = await api("/api/secrets", {
      method: "POST",
      body: JSON.stringify({ name, value: `e2e-dummy-${name}`, scope: "global" }),
    });
    expect(secretRes.status).toBe(201);
  }

  const { status } = await api<{ repo: { id: string } }>("/api/repos", {
    method: "POST",
    body: JSON.stringify({ repoUrl: REPO_URL, fullName: REPO_FULL_NAME, defaultBranch: "main" }),
  });
  expect(status).toBe(201);
}, 150_000);

afterAll(async () => {
  await server?.stop();
  if (shimDir) rmSync(shimDir, { recursive: true, force: true });
});

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface TaskRow {
  id: string;
  state: string;
  prUrl: string | null;
  costUsd: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  modelUsed: string | null;
  errorMessage: string | null;
  resultSummary: string | null;
}

interface TaskEvent {
  fromState: string | null;
  toState: string;
  trigger: string;
  message: string | null;
}

interface LogRow {
  content: string;
  logType: string | null;
}

/** Create an ad-hoc repo task. Mock directives go in the TITLE (see header). */
async function createTask(title: string): Promise<string> {
  const { status, body } = await api<{ task: TaskRow }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title,
      prompt: `E2E scenario: ${title}`,
      repoUrl: REPO_URL,
      agentType: "claude-code",
    }),
  });
  expect(status).toBe(201);
  // The route transitions the task to `queued` before responding and the
  // response carries the post-transition row — clients never see the
  // already-left `pending` state.
  expect(body.task.state).toBe("queued");
  return body.task.id;
}

async function getTask(taskId: string): Promise<TaskRow> {
  const { body } = await api<{ task: TaskRow }>(`/api/tasks/${taskId}`);
  return body.task;
}

async function waitForTaskState(taskId: string, states: string[]): Promise<TaskRow> {
  try {
    return await waitFor(
      async () => {
        const task = await getTask(taskId);
        return states.includes(task.state) ? task : null;
      },
      { timeoutMs: 90_000, label: `task ${taskId} → ${states.join("|")}` },
    );
  } catch (err) {
    throw new Error(
      `${err}\n--- server logs (tail) ---\n${server.logs().split("\n").slice(-40).join("\n")}`,
    );
  }
}

/** Poll the events endpoint until `trigger` appears; returns all events. */
async function waitForEventTrigger(taskId: string, trigger: string): Promise<TaskEvent[]> {
  return waitFor(
    async () => {
      const { body } = await api<{ events: TaskEvent[] }>(`/api/tasks/${taskId}/events`);
      return body.events.some((e) => e.trigger === trigger) ? body.events : null;
    },
    { timeoutMs: 30_000, label: `task ${taskId} event trigger=${trigger}` },
  );
}

describe("repo-task e2e", () => {
  it("reaches pr_opened with the PR URL, cost, and agent logs", async () => {
    const taskId = await createTask("Open a PR [[mock:pr]]");

    const task = await waitForTaskState(taskId, [
      "pr_opened",
      "completed",
      "failed",
      "needs_attention",
    ]);
    expect(task.state).toBe("pr_opened");
    expect(task.prUrl).toMatch(/^https:\/\/github\.com\/e2e-org\/e2e-repo\/pull\/\d+$/);
    expect(task.costUsd).toBe("0.0123");
    expect(task.inputTokens).toBe(100);
    expect(task.outputTokens).toBe(25);
    expect(task.modelUsed).toBe("fake-model");

    const events = await waitForEventTrigger(taskId, "pr_detected");
    const prEvent = events.find((e) => e.trigger === "pr_detected")!;
    expect(prEvent.fromState).toBe("running");
    expect(prEvent.toState).toBe("pr_opened");

    const { body: logsBody } = await api<{ logs: LogRow[] }>(`/api/tasks/${taskId}/logs`);
    const contents = logsBody.logs.map((l) => l.content).join("\n");
    expect(contents).toContain("Mock agent handled");
    expect(contents).toContain("Opened pull request: https://github.com/e2e-org/e2e-repo/pull/");
    expect(logsBody.logs.some((l) => l.logType === "system")).toBe(true);
  });

  it("escalates a successful run with no PR to needs_attention (completed_without_pr)", async () => {
    const taskId = await createTask("Complete without opening a PR");

    const task = await waitForTaskState(taskId, [
      "needs_attention",
      "completed",
      "failed",
      "pr_opened",
    ]);
    expect(task.state).toBe("needs_attention");
    expect(task.prUrl).toBeNull();
    expect(task.costUsd).toBe("0.0123");
    expect(task.errorMessage).toContain("did not open a pull request");

    const events = await waitForEventTrigger(taskId, "completed_without_pr");
    const escalation = events.find((e) => e.trigger === "completed_without_pr")!;
    expect(escalation.fromState).toBe("running");
    expect(escalation.toState).toBe("needs_attention");
  });

  it("fails terminally on an agent-reported error without retrying", async () => {
    // maxRetries is left at its default: BullMQ `attempts` only re-runs the
    // job when the worker THROWS. An agent-reported failure transitions the
    // task to failed without throwing, and the reconciler explicitly noops on
    // failed repo tasks without a PR ("failed_no_pr") — only a user retry
    // intent can re-queue. So failed is terminal here.
    const taskId = await createTask("Fail the run [[mock:fail]]");

    const task = await waitForTaskState(taskId, [
      "failed",
      "completed",
      "needs_attention",
      "pr_opened",
    ]);
    expect(task.state).toBe("failed");
    expect(task.errorMessage).toBe("Mock agent failure");
    expect(task.resultSummary).toContain("Agent error: Mock agent failure");

    const events = await waitForEventTrigger(taskId, "agent_failure");
    expect(events[events.length - 1].toState).toBe("failed");
    // One submission, one pickup — no automatic re-queue after the failure.
    expect(events.filter((e) => e.toState === "queued")).toHaveLength(1);
    expect(events.filter((e) => e.trigger === "worker_pickup")).toHaveLength(1);

    const after = await getTask(taskId);
    expect(after.state).toBe("failed");
  });

  it("fails with agent_no_output when the agent produces no output", async () => {
    const taskId = await createTask("Stay silent [[mock:silent]]");

    const task = await waitForTaskState(taskId, [
      "failed",
      "completed",
      "needs_attention",
      "pr_opened",
    ]);
    expect(task.state).toBe("failed");
    // No result event → adapter reports nominal success, so errorMessage from
    // updateTaskResult stays null; the no-output classification is carried by
    // the transition event (and its message).
    expect(task.errorMessage).toBeNull();

    const events = await waitForEventTrigger(taskId, "agent_no_output");
    const failure = events.find((e) => e.trigger === "agent_no_output")!;
    expect(failure.fromState).toBe("running");
    expect(failure.toState).toBe("failed");
    expect(failure.message).toContain("without producing any output");

    // The agent emitted nothing, so no log rows were persisted.
    const { body: logsBody } = await api<{ logs: LogRow[] }>(`/api/tasks/${taskId}/logs`);
    expect(logsBody.logs).toHaveLength(0);
  });

  it("accumulates cost and tokens across a resume instead of overwriting (issue #541)", async () => {
    // First run reports $0.05 and no PR → needs_attention, recording cost 0.05.
    const taskId = await createTask("Resume accumulates cost [[mock:cost:0.05]]");
    const first = await waitForTaskState(taskId, [
      "needs_attention",
      "completed",
      "failed",
      "pr_opened",
    ]);
    expect(first.state).toBe("needs_attention");
    expect(first.costUsd).toBe("0.05");
    expect(first.inputTokens).toBe(100);
    expect(first.outputTokens).toBe(25);

    // Resume with a fresh $0.03 invocation. The resumed claude process reports
    // only its OWN spend (0.03), so the persisted task total must ACCUMULATE to
    // 0.05 + 0.03 = 0.08 — not be overwritten to 0.03 (the pre-fix undercount).
    // The [[mock:cost:0.03]] directive leads the resume prompt, so it is the
    // first match the fake sees even though the original 0.05 prompt is appended
    // for context.
    const { status } = await api(`/api/tasks/${taskId}/resume`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Please continue [[mock:cost:0.03]]" }),
    });
    expect(status).toBe(200);

    const resumed = await waitFor(
      async () => {
        const t = await getTask(taskId);
        return t.costUsd === "0.08" ? t : null;
      },
      { timeoutMs: 90_000, label: `task ${taskId} cost accumulates to 0.08` },
    );
    expect(resumed.costUsd).toBe("0.08");
    // Tokens accumulate the same way: 100+100 input, 25+25 output.
    expect(resumed.inputTokens).toBe(200);
    expect(resumed.outputTokens).toBe(50);
  });

  it("preserves a failed attempt's cost across a bare retry (issue #580)", async () => {
    // The failed attempt still spent tokens: the fake reports $0.05 alongside
    // the error, and the task records it.
    const taskId = await createTask("Fail but spend [[mock:fail]] [[mock:cost:0.05]]");
    const first = await waitForTaskState(taskId, [
      "failed",
      "completed",
      "needs_attention",
      "pr_opened",
    ]);
    expect(first.state).toBe("failed");
    expect(first.costUsd).toBe("0.05");

    // Retry without a PR enqueues a bare {taskId} job — no continuation
    // signal. The relaunch re-runs the same prompt (fails again, another
    // $0.05); the prior attempt's spend must accumulate, not be overwritten.
    const { status } = await api(`/api/tasks/${taskId}/retry`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(status).toBe(200);

    const retried = await waitFor(
      async () => {
        const t = await getTask(taskId);
        return t.state === "failed" && t.costUsd === "0.1" ? t : null;
      },
      { timeoutMs: 90_000, label: `task ${taskId} accumulates failed-attempt cost to 0.1` },
    );
    expect(retried.costUsd).toBe("0.1");
  });
});
