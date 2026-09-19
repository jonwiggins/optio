/**
 * Integration tests for local runs — Jobs and Repo Tasks whose run location
 * is the owner's own machine — against real Postgres + Redis. A fake daemon
 * socket on the in-memory relay receives the spawn / kill frames; the daemon
 * handlers (started / exit / links / usage / spawn-error) drive the run's
 * state through local-run-service.syncLinkedRun.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { TaskState, WorkflowRunState } from "@optio/shared";
import { db } from "../db/client.js";
import { tasks, workflowRuns } from "../db/schema.js";
import * as relay from "./local-relay.js";
import { registerHost } from "./local-host-service.js";
import {
  flushParkedTerminals,
  getTerminal,
  handleExit,
  handleLinks,
  handleSession,
  handleSpawnError,
  handleStarted,
  handleUsage,
} from "./local-terminal-service.js";
import {
  cancelWorkflowRun,
  createWorkflow,
  createWorkflowRun,
  getWorkflowRun,
} from "./workflow-service.js";
import * as taskService from "./task-service.js";
import {
  dispatchLocalTask,
  dispatchLocalWorkflowRun,
  killLinkedTerminal,
} from "./local-run-service.js";

class FakeDaemonSocket implements relay.RelaySocket {
  readyState = 1;
  sent: string[] = [];
  send(data: string | Buffer) {
    this.sent.push(String(data));
  }
  close() {
    this.readyState = 3;
  }
  messages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
  spawns() {
    return this.messages().filter((m) => m.type === "spawn");
  }
}

const REPO_URL = "https://github.com/acme/optio";
const DIRS = [{ path: "/home/dev/optio", repoUrl: REPO_URL }, { path: "/home/dev/scratch" }];

async function makeHost(online = true) {
  const host = await registerHost({
    userId: null,
    workspaceId: null,
    hostname: `it-local-run-${Math.random().toString(36).slice(2, 8)}`,
    platform: "darwin",
    arch: "arm64",
    daemonVersion: "0.1.0",
    dirs: DIRS,
  });
  const daemon = new FakeDaemonSocket();
  if (online) relay.registerDaemon(host.id, null, daemon);
  return { host, daemon };
}

async function makeLocalJob(
  hostId: string,
  overrides: Partial<Parameters<typeof createWorkflow>[0]> = {},
) {
  return createWorkflow({
    name: `local-job-${Math.random().toString(36).slice(2, 8)}`,
    promptTemplate: "Say hello to {{name}}",
    agentRuntime: "claude-code",
    maxRetries: 1,
    runTarget: "local",
    localHostId: hostId,
    localDir: "/home/dev/scratch",
    localSessionMode: "headless",
    ...overrides,
  });
}

async function makeLocalTask(hostId: string, overrides: Record<string, unknown> = {}) {
  const task = await taskService.createTask({
    title: "Fix the flaky test",
    prompt: "Make it deterministic.",
    repoUrl: REPO_URL,
    repoBranch: "main",
    agentType: "claude-code",
    runTarget: "local",
    localHostId: hostId,
    localDir: "/home/dev/optio",
    localSessionMode: "headless",
    ...overrides,
  });
  await taskService.transitionTask(task.id, TaskState.QUEUED, "test");
  return (await taskService.getTask(task.id))!;
}

/** Fire-and-forget hooks (kill on cancel) settle on the next macrotask. */
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => relay.resetRelayForTests());
afterEach(() => relay.resetRelayForTests());

describe("local job runs", () => {
  it("spawns an agent terminal for a queued run and mirrors its lifecycle onto the run", async () => {
    const { host, daemon } = await makeHost();
    const workflow = await makeLocalJob(host.id);
    const run = await createWorkflowRun(workflow.id, { params: { name: "Ada" } });

    const terminal = await dispatchLocalWorkflowRun(run, workflow, "Say hello to Ada");
    expect(terminal).not.toBeNull();
    expect(terminal!.spawnedBy).toBe("job");
    expect(terminal!.workflowRunId).toBe(run.id);
    expect(terminal!.state).toBe("launching");

    const [spawn] = daemon.spawns();
    expect(spawn).toMatchObject({
      terminalId: terminal!.id,
      dir: "/home/dev/scratch",
      spec: { kind: "agent", agent: "claude-code", prompt: "Say hello to Ada", mode: "headless" },
    });

    // launching → the run is running with the terminal linked.
    let fresh = (await getWorkflowRun(run.id))!;
    expect(fresh.state).toBe(WorkflowRunState.RUNNING);
    expect(fresh.localTerminalId).toBe(terminal!.id);
    expect(fresh.startedAt).not.toBeNull();

    await handleStarted(host.id, terminal!.id);
    await handleSession(host.id, terminal!.id, "sess-42");
    await handleUsage(host.id, terminal!.id, {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turns: 2,
      model: "claude-sonnet-4-5",
      costUsd: 0.0421,
      updatedAt: new Date().toISOString(),
    });
    fresh = (await getWorkflowRun(run.id))!;
    expect(fresh.state).toBe(WorkflowRunState.RUNNING);
    expect(fresh.costUsd).toBe("0.0421");
    expect(fresh.inputTokens).toBe(1200);

    await handleExit(host.id, terminal!.id, 0);
    fresh = (await getWorkflowRun(run.id))!;
    expect(fresh.state).toBe(WorkflowRunState.COMPLETED);
    expect(fresh.finishedAt).not.toBeNull();
    expect(fresh.errorMessage).toBeNull();
    expect(fresh.modelUsed).toBe("claude-sonnet-4-5");
    expect((fresh.output as Record<string, unknown>).agentSessionId).toBe("sess-42");
  });

  it("is idempotent while the terminal is alive and replaces it only once dead", async () => {
    const { host, daemon } = await makeHost();
    const workflow = await makeLocalJob(host.id);
    const run = await createWorkflowRun(workflow.id);

    const first = await dispatchLocalWorkflowRun(run, workflow, "hi");
    const again = await dispatchLocalWorkflowRun((await getWorkflowRun(run.id))!, workflow, "hi");
    expect(again?.id).toBe(first!.id);
    expect(daemon.spawns()).toHaveLength(1);

    // Two dispatchers racing on a fresh run: exactly one terminal.
    const run2 = await createWorkflowRun(workflow.id);
    const [a, b] = await Promise.all([
      dispatchLocalWorkflowRun(run2, workflow, "hi"),
      dispatchLocalWorkflowRun(run2, workflow, "hi"),
    ]);
    expect(a?.id).toBe(b?.id);
    expect(daemon.spawns()).toHaveLength(2);
  });

  it("fails the run on a non-zero exit and on a spawn error", async () => {
    const { host, daemon } = await makeHost();
    const workflow = await makeLocalJob(host.id);

    const run = await createWorkflowRun(workflow.id);
    const t = (await dispatchLocalWorkflowRun(run, workflow, "hi"))!;
    await handleStarted(host.id, t.id);
    await handleExit(host.id, t.id, 2);
    const failed = (await getWorkflowRun(run.id))!;
    expect(failed.state).toBe(WorkflowRunState.FAILED);
    expect(failed.errorMessage).toContain("exited with code 2");

    const run2 = await createWorkflowRun(workflow.id);
    const t2 = (await dispatchLocalWorkflowRun(run2, workflow, "hi"))!;
    expect(daemon.spawns()).toHaveLength(2);
    await handleSpawnError(host.id, t2.id, "claude: command not found");
    const errored = (await getWorkflowRun(run2.id))!;
    expect(errored.state).toBe(WorkflowRunState.FAILED);
    expect(errored.errorMessage).toBe("claude: command not found");
  });

  it("parks the terminal while the host is offline and starts it on reconnect", async () => {
    const { host } = await makeHost(false);
    const workflow = await makeLocalJob(host.id);
    const run = await createWorkflowRun(workflow.id);

    const t = (await dispatchLocalWorkflowRun(run, workflow, "hi"))!;
    expect(t.state).toBe("pending");
    expect(t.pendingReason).toBe("host_offline");
    expect((await getWorkflowRun(run.id))!.state).toBe(WorkflowRunState.QUEUED);
    expect((await getWorkflowRun(run.id))!.localTerminalId).toBe(t.id);

    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);
    await flushParkedTerminals(host.id);
    expect(daemon.spawns()).toHaveLength(1);
    expect((await getWorkflowRun(run.id))!.state).toBe(WorkflowRunState.RUNNING);
  });

  it("fails a run whose agent runtime cannot run locally, with retries exhausted", async () => {
    const { host, daemon } = await makeHost();
    const workflow = await makeLocalJob(host.id, { agentRuntime: "copilot", maxRetries: 3 });
    const run = await createWorkflowRun(workflow.id);

    expect(await dispatchLocalWorkflowRun(run, workflow, "hi")).toBeNull();
    expect(daemon.spawns()).toHaveLength(0);
    const failed = (await getWorkflowRun(run.id))!;
    expect(failed.state).toBe(WorkflowRunState.FAILED);
    expect(failed.errorMessage).toContain("copilot");
    expect(failed.retryCount).toBe(3);
  });

  it("cancelling a local run kills its terminal", async () => {
    const { host, daemon } = await makeHost();
    const workflow = await makeLocalJob(host.id);
    const run = await createWorkflowRun(workflow.id);
    const t = (await dispatchLocalWorkflowRun(run, workflow, "hi"))!;
    await handleStarted(host.id, t.id);

    const cancelled = await cancelWorkflowRun(run.id);
    expect(cancelled.state).toBe(WorkflowRunState.FAILED);
    expect(cancelled.errorMessage).toBe("Cancelled by user");
    await settle();
    expect(daemon.messages().some((m) => m.type === "kill" && m.terminalId === t.id)).toBe(true);

    // The daemon's exit for the killed process changes nothing further.
    await handleExit(host.id, t.id, 143);
    const after = (await getWorkflowRun(run.id))!;
    expect(after.state).toBe(WorkflowRunState.FAILED);
    expect(after.errorMessage).toBe("Cancelled by user");
  });
});

describe("local repo tasks", () => {
  it("runs in the checkout, promotes to pr_opened on the PR link, and stays there after exit", async () => {
    const { host, daemon } = await makeHost();
    const task = await makeLocalTask(host.id);

    const t = (await dispatchLocalTask(task))!;
    expect(t.spawnedBy).toBe("task");
    expect(t.taskId).toBe(task.id);
    const [spawn] = daemon.spawns();
    expect(spawn.dir).toBe("/home/dev/optio");
    const spec = spawn.spec as Record<string, unknown>;
    expect(spec).toMatchObject({ kind: "agent", agent: "claude-code", mode: "headless" });
    expect(String(spec.prompt)).toContain("Make it deterministic.");
    expect(String(spec.prompt)).toContain(`optio/task-${task.id}`);
    expect(String(spec.prompt)).toContain("gh pr create");

    // launching → provisioning; started → running.
    expect((await taskService.getTask(task.id))!.state).toBe(TaskState.PROVISIONING);
    expect((await taskService.getTask(task.id))!.localTerminalId).toBe(t.id);
    await handleStarted(host.id, t.id);
    expect((await taskService.getTask(task.id))!.state).toBe(TaskState.RUNNING);

    await handleSession(host.id, t.id, "claude-sess-1");
    expect((await taskService.getTask(task.id))!.sessionId).toBe("claude-sess-1");

    // A PR for another repo is ignored; the task's own PR promotes it.
    await handleLinks(host.id, t.id, [
      { url: "https://github.com/other/repo/pull/1", kind: "pr", provider: "github", label: "#1" },
    ]);
    expect((await taskService.getTask(task.id))!.state).toBe(TaskState.RUNNING);
    await handleLinks(host.id, t.id, [
      { url: "https://github.com/other/repo/pull/1", kind: "pr", provider: "github", label: "#1" },
      { url: `${REPO_URL}/pull/77`, kind: "pr", provider: "github", label: "#77" },
    ]);
    let fresh = (await taskService.getTask(task.id))!;
    expect(fresh.state).toBe(TaskState.PR_OPENED);
    expect(fresh.prUrl).toBe(`${REPO_URL}/pull/77`);
    expect(fresh.prNumber).toBe(77);

    await handleExit(host.id, t.id, 0);
    fresh = (await taskService.getTask(task.id))!;
    expect(fresh.state).toBe(TaskState.PR_OPENED);
  });

  it("completes on a clean exit without a PR and fails on a non-zero exit", async () => {
    const { host } = await makeHost();

    const done = await makeLocalTask(host.id);
    const t1 = (await dispatchLocalTask(done))!;
    await handleStarted(host.id, t1.id);
    await handleExit(host.id, t1.id, 0);
    expect((await taskService.getTask(done.id))!.state).toBe(TaskState.COMPLETED);

    const broken = await makeLocalTask(host.id);
    const t2 = (await dispatchLocalTask(broken))!;
    await handleStarted(host.id, t2.id);
    await handleExit(host.id, t2.id, 1);
    const failed = (await taskService.getTask(broken.id))!;
    expect(failed.state).toBe(TaskState.FAILED);
    expect(failed.errorMessage).toContain("exited with code 1");
  });

  it("a PR printed before a non-zero exit still lands the task in pr_opened", async () => {
    const { host } = await makeHost();
    const task = await makeLocalTask(host.id);
    const t = (await dispatchLocalTask(task))!;
    await handleStarted(host.id, t.id);
    // Links and exit collapse into one frame pair on a fast agent.
    await handleLinks(host.id, t.id, [
      { url: `${REPO_URL}/pull/5`, kind: "pr", provider: "github", label: "#5" },
    ]);
    await handleExit(host.id, t.id, 1);
    const fresh = (await taskService.getTask(task.id))!;
    expect(fresh.state).toBe(TaskState.PR_OPENED);
    expect(fresh.prUrl).toBe(`${REPO_URL}/pull/5`);
  });

  it("fails the task at dispatch when the directory left the allowlist", async () => {
    const { host, daemon } = await makeHost();
    const task = await makeLocalTask(host.id, { localDir: "/home/dev/gone" });
    expect(await dispatchLocalTask(task)).toBeNull();
    expect(daemon.spawns()).toHaveLength(0);
    const failed = (await taskService.getTask(task.id))!;
    expect(failed.state).toBe(TaskState.FAILED);
    expect(failed.errorMessage).toContain("/home/dev/gone");
  });

  it("cancelling a running local task kills its terminal; a resume spawns a fresh one", async () => {
    const { host, daemon } = await makeHost();
    const task = await makeLocalTask(host.id);
    const t = (await dispatchLocalTask(task))!;
    await handleStarted(host.id, t.id);

    await taskService.transitionTask(task.id, TaskState.CANCELLED, "user_cancel");
    await settle();
    expect(daemon.messages().some((m) => m.type === "kill" && m.terminalId === t.id)).toBe(true);
    await handleExit(host.id, t.id, 143);
    expect((await taskService.getTask(task.id))!.state).toBe(TaskState.CANCELLED);

    // Retry → queued → the worker dispatches again with a new terminal; the
    // resume prompt rides along and Claude Code resumes its own session.
    await taskService.transitionTask(task.id, TaskState.QUEUED, "user_retry");
    await db.update(tasks).set({ sessionId: "claude-sess-9" }).where(eq(tasks.id, task.id));
    const t2 = (await dispatchLocalTask((await taskService.getTask(task.id))!, {
      resumePrompt: "CI is red, fix it.",
      resumeSessionId: "claude-sess-9",
    }))!;
    expect(t2.id).not.toBe(t.id);
    const spawn = daemon.spawns().at(-1)!;
    expect(spawn.spec).toMatchObject({ kind: "agent", resumeSessionId: "claude-sess-9" });
    expect(String((spawn.spec as Record<string, unknown>).prompt).startsWith("CI is red")).toBe(
      true,
    );
    expect((await taskService.getTask(task.id))!.localTerminalId).toBe(t2.id);
  });

  it("killLinkedTerminal is a no-op for dead or unknown terminals", async () => {
    const { host, daemon } = await makeHost();
    const task = await makeLocalTask(host.id);
    const t = (await dispatchLocalTask(task))!;
    await handleStarted(host.id, t.id);
    await handleExit(host.id, t.id, 0);
    const sentBefore = daemon.sent.length;
    await killLinkedTerminal(t.id, "test");
    await killLinkedTerminal("00000000-0000-0000-0000-000000000000", "test");
    expect(daemon.sent.length).toBe(sentBefore);
    expect((await getTerminal(t.id))!.state).toBe("exited");
  });
});

describe("workflow_runs ↔ local_terminals bookkeeping", () => {
  it("ignores frames from a superseded terminal", async () => {
    const { host } = await makeHost();
    const workflow = await makeLocalJob(host.id);
    const run = await createWorkflowRun(workflow.id);
    const t1 = (await dispatchLocalWorkflowRun(run, workflow, "hi"))!;
    await handleStarted(host.id, t1.id);
    await handleExit(host.id, t1.id, 1);
    // Retry: back to queued, new attempt.
    await db
      .update(workflowRuns)
      .set({ state: WorkflowRunState.QUEUED, finishedAt: null, errorMessage: null })
      .where(eq(workflowRuns.id, run.id));
    const t2 = (await dispatchLocalWorkflowRun((await getWorkflowRun(run.id))!, workflow, "hi"))!;
    expect(t2.id).not.toBe(t1.id);
    expect((await getWorkflowRun(run.id))!.state).toBe(WorkflowRunState.RUNNING);
    // A late frame for the old terminal must not touch the new attempt.
    await handleLinks(host.id, t1.id, []);
    expect((await getWorkflowRun(run.id))!.state).toBe(WorkflowRunState.RUNNING);
    expect((await getWorkflowRun(run.id))!.localTerminalId).toBe(t2.id);
  });
});
