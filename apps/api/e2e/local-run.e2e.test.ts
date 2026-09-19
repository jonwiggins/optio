/**
 * E2E: Jobs and Repo Tasks whose run location is the user's own machine,
 * through the real API server and its workers. A scripted fake daemon speaks
 * the /ws/local/daemon protocol; the workflow / task workers dispatch queued
 * runs to it instead of provisioning pods, and its frames (started, usage,
 * links, exit) drive the run's state back through local-run-service.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;
let wsBase: string;

beforeAll(async () => {
  server = await startApiServer();
  wsBase = server.baseUrl.replace(/^http/, "ws");
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

type Json = Record<string, unknown>;

/** Minimal scripted daemon speaking the /ws/local/daemon protocol. */
class FakeDaemon {
  ws!: WebSocket;
  inbox: Json[] = [];
  private waiters: Array<{ match: (m: Json) => boolean; resolve: (m: Json) => void }> = [];

  async connect(hostId: string, dirs: Json[], terminals: Json[] = []): Promise<void> {
    this.ws = new WebSocket(`${wsBase}/ws/local/daemon`);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("daemon ws failed"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as Json;
      const idx = this.waiters.findIndex((w) => w.match(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        this.inbox.push(msg);
      }
    };
    this.send({ type: "hello", hostId, daemonVersion: "0.0.0-e2e", dirs, terminals });
  }

  send(msg: Json): void {
    this.ws.send(JSON.stringify(msg));
  }

  async next(match: (m: Json) => boolean, timeoutMs = 30_000): Promise<Json> {
    const idx = this.inbox.findIndex(match);
    if (idx >= 0) return this.inbox.splice(idx, 1)[0];
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("fake daemon: timed out waiting for message")),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

const REPO_URL = "https://github.com/acme/e2e";
const DIRS = [{ path: "/tmp/e2e-repo", repoUrl: REPO_URL }, { path: "/tmp/e2e-scratch" }];

interface HostBody {
  host: { id: string; state: string };
}
interface RunBody {
  run: {
    id: string;
    workflowId: string;
    state: string;
    costUsd: string | null;
    errorMessage: string | null;
    localTerminalId: string | null;
    output: Record<string, unknown> | null;
  };
}
interface TaskBody {
  task: {
    id: string;
    state: string;
    runTarget: string;
    localTerminalId: string | null;
    prUrl: string | null;
    errorMessage: string | null;
    sessionId: string | null;
  };
}
interface TerminalBody {
  terminal: {
    id: string;
    state: string;
    spawnedBy: string;
    workflowRunId: string | null;
    taskId: string | null;
    spec: Json;
  };
}

async function registerHost(hostname: string): Promise<string> {
  const { status, body } = await api<HostBody>("/api/local/hosts/register", {
    method: "POST",
    body: JSON.stringify({ hostname, platform: "darwin", arch: "arm64", dirs: DIRS }),
  });
  expect(status).toBe(200);
  return body.host.id;
}

async function onlineHost(hostname: string, cleanups: Array<() => void>) {
  const hostId = await registerHost(hostname);
  const daemon = new FakeDaemon();
  cleanups.push(() => daemon.close());
  await daemon.connect(hostId, DIRS);
  await waitFor(async () => {
    const { body } = await api<{ hosts: HostBody["host"][] }>("/api/local/hosts");
    return body.hosts.find((h) => h.id === hostId)?.state === "online" ? true : null;
  });
  return { hostId, daemon };
}

const getRun = async (id: string) => (await api<RunBody>(`/api/workflow-runs/${id}`)).body.run;
const getTask = async (id: string) => (await api<TaskBody>(`/api/tasks/${id}`)).body.task;
const getTerminal = async (id: string) =>
  (await api<TerminalBody>(`/api/local/terminals/${id}`)).body.terminal;

async function createLocalJob(hostId: string, extra: Json = {}): Promise<string> {
  const { status, body } = await api<{ task: { id: string; runTarget: string } }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      type: "standalone",
      name: `e2e local job ${Math.random().toString(36).slice(2, 8)}`,
      prompt: "Say hello to {{name}}",
      agentType: "claude-code",
      runTarget: "local",
      localHostId: hostId,
      localDir: "/tmp/e2e-scratch",
      localSessionMode: "headless",
      maxRetries: 0,
      ...extra,
    }),
  });
  expect(status).toBe(201);
  expect(body.task.runTarget).toBe("local");
  return body.task.id;
}

async function startRun(jobId: string, params?: Json): Promise<string> {
  const { status, body } = await api<{ runId: string }>(`/api/tasks/${jobId}/runs`, {
    method: "POST",
    body: JSON.stringify(params ? { params } : {}),
  });
  expect(status).toBe(202);
  return body.runId;
}

describe("local runs e2e", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("runs a Job on a local host: spawn → running → usage → exit → completed", async () => {
    const { hostId, daemon } = await onlineHost("e2e-local-job", cleanups);
    const jobId = await createLocalJob(hostId);
    const runId = await startRun(jobId, { name: "Ada" });

    // The workflow worker hands the queued run to the daemon.
    const spawn = await daemon.next((m) => m.type === "spawn");
    expect(spawn.dir).toBe("/tmp/e2e-scratch");
    expect(spawn.spec).toMatchObject({
      kind: "agent",
      agent: "claude-code",
      mode: "headless",
      prompt: "Say hello to Ada",
    });
    const terminalId = String(spawn.terminalId);

    const running = await waitFor(async () => {
      const run = await getRun(runId);
      return run.state === "running" ? run : null;
    });
    expect(running.localTerminalId).toBe(terminalId);

    const terminal = await getTerminal(terminalId);
    expect(terminal.spawnedBy).toBe("job");
    expect(terminal.workflowRunId).toBe(runId);

    daemon.send({ type: "started", terminalId });
    daemon.send({ type: "session", terminalId, agentSessionId: "sess-e2e-1" });
    daemon.send({
      type: "usage",
      terminalId,
      usage: {
        inputTokens: 500,
        outputTokens: 80,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        turns: 1,
        model: "claude-sonnet-4-5",
        costUsd: 0.0031,
        updatedAt: new Date().toISOString(),
      },
    });
    daemon.send({ type: "exit", terminalId, exitCode: 0 });

    const done = await waitFor(async () => {
      const run = await getRun(runId);
      return run.state === "completed" || run.state === "failed" ? run : null;
    });
    expect(done.state).toBe("completed");
    expect(done.costUsd).toBe("0.0031");
    expect(done.output?.agentSessionId).toBe("sess-e2e-1");
  });

  it("parks a local Job run while the host is offline and starts it on reconnect", async () => {
    const hostId = await registerHost("e2e-local-offline");
    const jobId = await createLocalJob(hostId);
    const runId = await startRun(jobId);

    // Dispatched: terminal exists, parked; run still queued.
    const parked = await waitFor(async () => {
      const run = await getRun(runId);
      return run.localTerminalId ? run : null;
    });
    expect(parked.state).toBe("queued");
    const terminal = await getTerminal(parked.localTerminalId!);
    expect(terminal.state).toBe("pending");

    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(hostId, DIRS);
    const spawn = await daemon.next((m) => m.type === "spawn");
    expect(spawn.terminalId).toBe(parked.localTerminalId);
    await waitFor(async () => ((await getRun(runId)).state === "running" ? true : null));
  });

  it("cancelling a local Job run kills the terminal and the run fails as cancelled", async () => {
    const { hostId, daemon } = await onlineHost("e2e-local-cancel", cleanups);
    const jobId = await createLocalJob(hostId);
    const runId = await startRun(jobId);
    const spawn = await daemon.next((m) => m.type === "spawn");
    const terminalId = String(spawn.terminalId);
    daemon.send({ type: "started", terminalId });
    await waitFor(async () => ((await getRun(runId)).state === "running" ? true : null));

    const { status } = await api(`/api/workflow-runs/${runId}/cancel`, {
      method: "POST",
      body: "{}",
    });
    expect(status).toBe(200);
    const kill = await daemon.next((m) => m.type === "kill" && m.terminalId === terminalId);
    expect(kill).toBeTruthy();
    daemon.send({ type: "exit", terminalId, exitCode: 143 });

    const run = await getRun(runId);
    expect(run.state).toBe("failed");
    expect(run.errorMessage).toBe("Cancelled by user");
  });

  it("runs a Repo Task in the local checkout and promotes it to pr_opened from the PR link", async () => {
    const { hostId, daemon } = await onlineHost("e2e-local-task", cleanups);
    const { status, body } = await api<TaskBody>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "repo-task",
        title: "Deflake the suite",
        prompt: "Make the suite deterministic.",
        repoUrl: REPO_URL,
        repoBranch: "main",
        agentType: "claude-code",
        runTarget: "local",
        localHostId: hostId,
        localDir: "/tmp/e2e-repo",
      }),
    });
    expect(status).toBe(201);
    expect(body.task.runTarget).toBe("local");
    const taskId = body.task.id;

    const spawn = await daemon.next((m) => m.type === "spawn");
    expect(spawn.dir).toBe("/tmp/e2e-repo");
    const prompt = String((spawn.spec as Json).prompt);
    expect(prompt).toContain("Make the suite deterministic.");
    expect(prompt).toContain(`optio/task-${taskId}`);
    expect(prompt).toContain("gh pr create");
    const terminalId = String(spawn.terminalId);

    await waitFor(async () => ((await getTask(taskId)).state === "provisioning" ? true : null));
    daemon.send({ type: "started", terminalId });
    await waitFor(async () => ((await getTask(taskId)).state === "running" ? true : null));
    const terminal = await getTerminal(terminalId);
    expect(terminal.spawnedBy).toBe("task");
    expect(terminal.taskId).toBe(taskId);

    daemon.send({
      type: "links",
      terminalId,
      links: [{ url: `${REPO_URL}/pull/12`, kind: "pr", provider: "github", label: "#12" }],
    });
    const opened = await waitFor(async () => {
      const t = await getTask(taskId);
      return t.state === "pr_opened" ? t : null;
    });
    expect(opened.prUrl).toBe(`${REPO_URL}/pull/12`);

    daemon.send({ type: "exit", terminalId, exitCode: 0 });
    await waitFor(async () => ((await getTerminal(terminalId)).state === "exited" ? true : null));
    expect((await getTask(taskId)).state).toBe("pr_opened");
  });

  it("rejects local locations that cannot work", async () => {
    const hostId = await registerHost("e2e-local-reject");
    const post = (extra: Json) =>
      api<{ error?: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          type: "standalone",
          name: `bad ${Math.random()}`,
          prompt: "x",
          agentType: "claude-code",
          runTarget: "local",
          localHostId: hostId,
          localDir: "/tmp/e2e-scratch",
          ...extra,
        }),
      });

    expect((await post({ localDir: "/etc" })).status).toBe(400);
    expect((await post({ agentType: "copilot" })).status).toBe(400);
    expect((await post({ localHostId: "00000000-0000-0000-0000-000000000000" })).status).toBe(400);
    // A Repo Task in a directory that is a checkout of a different repo.
    const other = await api<{ error?: string }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "repo-task",
        title: "wrong checkout",
        prompt: "x",
        repoUrl: "https://github.com/acme/another",
        agentType: "claude-code",
        runTarget: "local",
        localHostId: hostId,
        localDir: "/tmp/e2e-repo",
      }),
    });
    expect(other.status).toBe(400);
    expect(other.body.error).toContain("checkout of");
  });
});
