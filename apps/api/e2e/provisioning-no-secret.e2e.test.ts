/**
 * E2E: a repo task whose required agent secret is missing must fail
 * TERMINALLY during provisioning — not retry forever.
 *
 * This server deliberately seeds NO secrets (unlike repo-task.e2e.test.ts).
 * The task-worker's secret resolution throws
 * `Secret not found: ANTHROPIC_API_KEY (scope: global)` while the task is in
 * `provisioning`. Before the fix this was classified as recoverable, so the
 * task bounced queued↔provisioning on 30s requeues indefinitely (the
 * reconciler re-enqueues without the provisioningRetryCount, defeating the
 * retry cap). Now the missing-secret error is classified as permanent:
 * exactly one worker pickup, one `provisioning_permanent_failure` transition,
 * terminal `failed` with the actionable message on the task row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

const REPO_URL = "https://github.com/e2e-org/e2e-no-secret-repo";
const REPO_FULL_NAME = "e2e-org/e2e-no-secret-repo";

let server: ApiServerHandle;

beforeAll(async () => {
  server = await startApiServer();

  // NOTE: no secrets are seeded — that is the scenario under test. The
  // claude-code adapter (default api-key auth mode) hard-requires
  // ANTHROPIC_API_KEY, so provisioning must fail permanently.
  const { status } = await api("/api/repos", {
    method: "POST",
    body: JSON.stringify({ repoUrl: REPO_URL, fullName: REPO_FULL_NAME, defaultBranch: "main" }),
  });
  expect(status).toBe(201);
}, 150_000);

afterAll(async () => {
  await server?.stop();
});

async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface TaskRow {
  id: string;
  state: string;
  errorMessage: string | null;
}

interface TaskEvent {
  fromState: string | null;
  toState: string;
  trigger: string;
  message: string | null;
}

async function getTask(taskId: string): Promise<TaskRow> {
  const { body } = await api<{ task: TaskRow }>(`/api/tasks/${taskId}`);
  return body.task;
}

async function getEvents(taskId: string): Promise<TaskEvent[]> {
  const { body } = await api<{ events: TaskEvent[] }>(`/api/tasks/${taskId}/events`);
  return body.events;
}

describe("repo task provisioning without required secrets", () => {
  it("fails terminally with the missing-secret message instead of retrying forever", async () => {
    const { status, body } = await api<{ task: TaskRow }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "No secrets configured",
        prompt: "E2E scenario: provisioning without secrets",
        repoUrl: REPO_URL,
        agentType: "claude-code",
      }),
    });
    expect(status).toBe(201);
    // The response is the post-transition row (queued), never the stale
    // pending row.
    expect(body.task.state).toBe("queued");
    const taskId = body.task.id;

    // The worker picks the task up, moves it to provisioning, hits the
    // missing secret, and must land in terminal `failed` — no bounce loop.
    const task = await waitFor(
      async () => {
        const t = await getTask(taskId);
        return t.state === "failed" ? t : null;
      },
      { timeoutMs: 90_000, label: `task ${taskId} → failed` },
    ).catch((err) => {
      throw new Error(
        `${err}\n--- server logs (tail) ---\n${server.logs().split("\n").slice(-40).join("\n")}`,
      );
    });

    expect(task.errorMessage).toContain("Secret not found: ANTHROPIC_API_KEY");

    const events = await getEvents(taskId);
    const failure = events.find((e) => e.trigger === "provisioning_permanent_failure");
    expect(failure).toBeDefined();
    expect(failure!.fromState).toBe("provisioning");
    expect(failure!.toState).toBe("failed");
    expect(failure!.message).toContain("Secret not found: ANTHROPIC_API_KEY");

    // Exactly one pickup, zero recoverable requeues — the old behavior
    // produced an endless provisioning_retry / worker_pickup train.
    expect(events.filter((e) => e.trigger === "worker_pickup")).toHaveLength(1);
    expect(events.filter((e) => e.trigger === "provisioning_retry")).toHaveLength(0);

    // Let a few reconciler/stall-check cycles pass (2s intervals in the e2e
    // harness) and confirm nothing resurrects the task.
    await new Promise((r) => setTimeout(r, 5_000));

    const after = await getTask(taskId);
    expect(after.state).toBe("failed");
    const eventsAfter = await getEvents(taskId);
    expect(eventsAfter.filter((e) => e.trigger === "worker_pickup")).toHaveLength(1);
    expect(eventsAfter.filter((e) => e.trigger === "provisioning_retry")).toHaveLength(0);
  });
});
