/**
 * E2E: fresh pod per run through the real API server with the fake runtime.
 *
 * A repo set to `podMode: "per_run"` gives every task run its own pod, removed
 * when the run ends: two consecutive runs land on different pods, and the pod
 * of a finished, failed or cancelled run is gone from the cluster listing. A
 * repo left on the default keeps sharing its pod across runs, as before.
 * Mock directives go in the task title (see repo-task.e2e.test.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

const FRESH_REPO = "https://github.com/e2e-org/fresh-repo";
const SHARED_REPO = "https://github.com/e2e-org/shared-repo";

let server: ApiServerHandle;
let shimDir: string;

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function addRepo(repoUrl: string, fullName: string): Promise<string> {
  const { status, body } = await api<{ repo: { id: string } }>("/api/repos", {
    method: "POST",
    body: JSON.stringify({ repoUrl, fullName, defaultBranch: "main" }),
  });
  expect(status).toBe(201);
  return body.repo.id;
}

beforeAll(async () => {
  // Never touch a live cluster from the bare-pod path's kubectl calls.
  shimDir = mkdtempSync(join(tmpdir(), "optio-e2e-kubectl-"));
  writeFileSync(join(shimDir, "kubectl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  server = await startApiServer({
    env: { PATH: `${shimDir}:${process.env.PATH ?? ""}`, OPTIO_PR_WATCH_INTERVAL: "600000" },
  });
  for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
    const res = await api("/api/secrets", {
      method: "POST",
      body: JSON.stringify({ name, value: `e2e-dummy-${name}`, scope: "global" }),
    });
    expect(res.status).toBe(201);
  }
  const freshId = await addRepo(FRESH_REPO, "e2e-org/fresh-repo");
  await addRepo(SHARED_REPO, "e2e-org/shared-repo");
  const patched = await api<{ repo: { podMode: string | null } }>(`/api/repos/${freshId}`, {
    method: "PATCH",
    body: JSON.stringify({ podMode: "per_run" }),
  });
  expect(patched.status).toBe(200);
  expect(patched.body.repo.podMode).toBe("per_run");
}, 150_000);

afterAll(async () => {
  await server?.stop();
  if (shimDir) rmSync(shimDir, { recursive: true, force: true });
});

interface TaskRow {
  id: string;
  state: string;
  lastPodId: string | null;
}

async function createTask(repoUrl: string, title: string): Promise<string> {
  const { status, body } = await api<{ task: TaskRow }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title, prompt: `E2E: ${title}`, repoUrl, agentType: "claude-code" }),
  });
  expect(status).toBe(201);
  return body.task.id;
}

async function getTask(id: string): Promise<TaskRow> {
  return (await api<{ task: TaskRow }>(`/api/tasks/${id}`)).body.task;
}

async function waitForState(id: string, states: string[]): Promise<TaskRow> {
  try {
    return await waitFor(
      async () => {
        const task = await getTask(id);
        return states.includes(task.state) ? task : null;
      },
      { timeoutMs: 90_000, label: `task ${id} → ${states.join("|")}` },
    );
  } catch (err) {
    throw new Error(
      `${err}\n--- server logs (tail) ---\n${server.logs().split("\n").slice(-40).join("\n")}`,
    );
  }
}

async function podIds(): Promise<string[]> {
  const { status, body } = await api<{ pods: Array<{ id: string }> }>("/api/cluster/pods");
  expect(status).toBe(200);
  return body.pods.map((p) => p.id);
}

/** The pod is removed once its run lets go of it (just after the terminal state). */
async function waitForPodGone(podId: string): Promise<void> {
  await waitFor(async () => ((await podIds()).includes(podId) ? null : true), {
    timeoutMs: 30_000,
    label: `pod ${podId} removed`,
  });
}

const DONE = ["needs_attention", "completed", "failed", "pr_opened", "cancelled"];

describe("fresh pod per run", () => {
  it("gives two consecutive runs different pods and removes each when it ends", async () => {
    const first = await waitForState(await createTask(FRESH_REPO, "Fresh run one"), DONE);
    expect(first.state).toBe("needs_attention");
    expect(first.lastPodId).toBeTruthy();
    await waitForPodGone(first.lastPodId!);

    const second = await waitForState(await createTask(FRESH_REPO, "Fresh run two"), DONE);
    expect(second.state).toBe("needs_attention");
    expect(second.lastPodId).toBeTruthy();
    expect(second.lastPodId).not.toBe(first.lastPodId);
    await waitForPodGone(second.lastPodId!);
  });

  it("removes the pod of a failed run", async () => {
    const failed = await waitForState(await createTask(FRESH_REPO, "Break [[mock:fail]]"), DONE);
    expect(failed.state).toBe("failed");
    expect(failed.lastPodId).toBeTruthy();
    await waitForPodGone(failed.lastPodId!);
  });

  it("removes the pod of a cancelled run", async () => {
    const id = await createTask(FRESH_REPO, "Hang until cancelled [[mock:hang]]");
    const running = await waitForState(id, ["running", ...DONE]);
    expect(running.state).toBe("running");
    expect(running.lastPodId).toBeTruthy();
    expect(await podIds()).toContain(running.lastPodId);

    const cancel = await api(`/api/tasks/${id}/cancel`, { method: "POST", body: "{}" });
    expect(cancel.status).toBe(200);
    expect((await waitForState(id, DONE)).state).toBe("cancelled");
    await waitForPodGone(running.lastPodId!);
  });

  it("keeps sharing the pod across runs on a repo left on the default", async () => {
    const first = await waitForState(await createTask(SHARED_REPO, "Shared run one"), DONE);
    const second = await waitForState(await createTask(SHARED_REPO, "Shared run two"), DONE);
    expect(first.lastPodId).toBeTruthy();
    expect(second.lastPodId).toBe(first.lastPodId);
    expect(await podIds()).toContain(first.lastPodId);
  });
});
