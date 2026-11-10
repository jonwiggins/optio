/**
 * E2E: pod scope. By default a repo's runs share its pod (a worktree each);
 * with `podScope: "run"` on the repo — or OPTIO_POD_SCOPE=run for the whole
 * deployment — every task gets a pod of its own.
 *
 * Real API server, fake runtime. The pod a task ran in is its `containerId`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

const SHARED_REPO = "https://github.com/e2e-org/pod-shared";
const PER_RUN_REPO = "https://github.com/e2e-org/pod-per-run";

let server: ApiServerHandle;
let shimDir: string;

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface RepoRow {
  id: string;
  podScope: "repo" | "run" | null;
}
interface TaskRow {
  id: string;
  state: string;
  containerId: string | null;
}

async function addRepo(repoUrl: string): Promise<RepoRow> {
  const { status, body } = await api<{ repo: RepoRow }>("/api/repos", {
    method: "POST",
    body: JSON.stringify({
      repoUrl,
      fullName: repoUrl.replace("https://github.com/", ""),
      defaultBranch: "main",
    }),
  });
  expect(status).toBe(201);
  return body.repo;
}

/** Runs a task to its PR and says which pod it ran in. */
async function podOfTask(repoUrl: string, title: string): Promise<string> {
  const created = await api<{ task: TaskRow }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: `${title} [[mock:pr]]`,
      prompt: title,
      repoUrl,
      agentType: "claude-code",
    }),
  });
  expect(created.status).toBe(201);
  const id = created.body.task.id;
  let task: TaskRow;
  try {
    task = await waitFor(
      async () => {
        const { body } = await api<{ task: TaskRow }>(`/api/tasks/${id}`);
        return ["pr_opened", "failed", "needs_attention"].includes(body.task.state)
          ? body.task
          : null;
      },
      { timeoutMs: 90_000, label: `task ${id} to finish` },
    );
  } catch (err) {
    throw new Error(
      `${err}\n--- server logs (tail) ---\n${server.logs().split("\n").slice(-40).join("\n")}`,
    );
  }
  expect(task.state).toBe("pr_opened");
  expect(task.containerId).toBeTruthy();
  return task.containerId!;
}

beforeAll(async () => {
  // Keep the bare-pod path's kubectl calls away from any live cluster.
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
}, 150_000);

afterAll(async () => {
  await server?.stop();
  if (shimDir) rmSync(shimDir, { recursive: true, force: true });
});

describe("pod scope", () => {
  it("shares the repo's pod between its runs by default", async () => {
    const repo = await addRepo(SHARED_REPO);
    expect(repo.podScope).toBeNull();

    const first = await podOfTask(SHARED_REPO, "shared one");
    const second = await podOfTask(SHARED_REPO, "shared two");
    expect(second).toBe(first);
  }, 240_000);

  it("gives every run its own pod when the repo's pod scope is run", async () => {
    const repo = await addRepo(PER_RUN_REPO);
    const patched = await api<{ repo: RepoRow }>(`/api/repos/${repo.id}`, {
      method: "PATCH",
      body: JSON.stringify({ podScope: "run" }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.repo.podScope).toBe("run");

    const first = await podOfTask(PER_RUN_REPO, "own pod one");
    const second = await podOfTask(PER_RUN_REPO, "own pod two");
    expect(second).not.toBe(first);

    // Back to the deployment's default (shared): the next run reuses a pod of the repo's own.
    const cleared = await api<{ repo: RepoRow }>(`/api/repos/${repo.id}`, {
      method: "PATCH",
      body: JSON.stringify({ podScope: null }),
    });
    expect(cleared.body.repo.podScope).toBeNull();
    const third = await podOfTask(PER_RUN_REPO, "shared again");
    const fourth = await podOfTask(PER_RUN_REPO, "shared again two");
    expect(fourth).toBe(third);
    expect([first, second]).not.toContain(third);
  }, 360_000);
});
