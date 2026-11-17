/**
 * Shared setup and helpers for the scale-out-runs-*.e2e.test.ts files (split so CI shards spread them).
 *
 * E2E: agent runs outlive the API process that started them
 * (docs/plans/scale-out.md §1–2, Testing). Real API servers on one database,
 * one Redis and one fake-runtime directory (src/test-utils/e2e/api-cluster.ts):
 * fake agents are detached processes writing their run directory, so a run
 * goes on when its server is killed, and another server attaches to it.
 *
 * Every case checks the run's final state, that its log rows are exactly
 * the agent's lines — `tick 1`…`tick N` from `[[mock:ticks:N:MS]]`, each
 * once, no gap — and that its cost was added once.
 *
 *   1  one server, a Repo Task running, SIGKILL, a new server → completes
 *   2  the attached server killed → another attaches within 10 s
 *   3  three servers, ten runs across kinds, one killed → all complete, the
 *      global and per-repo limits never exceeded (the DB polled every 250 ms)
 *   4  cancel through a server that is not attached stops the agent
 *   5  a mid-run message through a server that is not attached reaches it
 *   9  SIGTERM to the attached server → another has the run in under 5 s
 *  10  the pod goes away mid-run → the run fails with the pod's reason
 *  11  a Job run and a persistent-agent turn through 1, 4 and 5
 *  12  a boot with runs in flight fails nothing
 *  13  a force-redo of a running task stops the old agent; only the new
 *      attempt's logs are kept, and it finishes once
 *  14  a review cancelled while its run is being set up: the run is
 *      cancelled, the agent stopped, nothing written to the review
 *  15  a Job edited mid-run (agent → command): the re-attach still reads
 *      the run as the agent it started
 *  16  SIGTERM while a run settles: it finishes there, once (one draft,
 *      one completion), never handed to another server half-settled
 *  17  a failed run's message carries the tail of the agent's stderr
 *  18  the log write fails once mid-stream: the run is re-attached (its
 *      agent left running) and completes, logs contiguous, cost once
 *  19  the log write fails every time: after 3 failed attaches the run
 *      fails and its agent is stopped
 *  20  an agent pod its creator abandoned mid-creation (the server died
 *      between the row and the pod) is taken over: the next turn runs
 *  21  the server making an agent's pod is killed: the turn it held is
 *      halted once its lease lapses, and the agent's next turn runs
 *
 * The lease is shortened (6 s, renewed every 2 s) and the attach sweep runs
 * every second, so a SIGKILLed server's runs move on in seconds.
 *
 * Every cluster in this file works on one database, so all of them share one
 * fake-runtime directory too: a pod row an earlier cluster left `ready`
 * still has its container, as a deployment's pods outlive its API servers
 * (with a directory per cluster, the next cluster's health check finds those
 * pods gone, cleans them up as crashed and marks the repo's running tasks
 * with the pod's error). The servers are hermetic (startApiServer): `kubectl`
 * is a failing stub, the Kubernetes API a read-only fake, and git platform
 * hosts are answered in-process, so nothing reaches a real cluster or
 * GitHub with the dummy credentials seeded here.
 */
import { expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import type { ApiCluster } from "../src/test-utils/e2e/api-cluster.js";
import { waitFor } from "../src/test-utils/e2e/api-server.js";

export const LEASE_MS = 6_000;
export const MAX_CONCURRENT = 4;
export const CLUSTER_ENV: Record<string, string> = {
  OPTIO_ATTACH_LEASE_MS: String(LEASE_MS),
  OPTIO_ATTACH_RENEW_MS: "2000",
  OPTIO_ATTACH_SWEEP_INTERVAL_MS: "1000",
  OPTIO_MAX_CONCURRENT: String(MAX_CONCURRENT),
  // Slow PR polling: the dummy GITHUB_TOKEN would hammer the real API.
  OPTIO_PR_WATCH_INTERVAL: "600000",
  // An agent whose result nobody streamed yet waits this long for its EOF.
  OPTIO_FAKE_EOF_TIMEOUT_MS: "120000",
  // Fake pods start at once: a pod row still provisioning after 15 s was
  // abandoned by a server that died creating it (case 3 can kill one then).
  OPTIO_STALE_PROVISIONING_MS: "15000",
};

export const REPO_A = "https://github.com/e2e-org/scale-a";
export const REPO_B = "https://github.com/e2e-org/scale-b";
export const REPO_DOOMED = "https://github.com/e2e-org/scale-doomed";

export const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });

/** The fake runtime's pods and runs, for every cluster in this file (see above). */
export const FAKE_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "optio-e2e-scale-out-"));

/** Each scale-out file closes the pool and removes the fake-runtime directory when it ends. */
export async function cleanup() {
  await sql.end({ timeout: 5 });
  rmSync(FAKE_RUNTIME_DIR, { recursive: true, force: true });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export type Client = ReturnType<ApiCluster["any"]>;

export let seeded = false;
export async function seed(api: Client) {
  if (seeded) return;
  for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
    const { status, body } = await api("/api/secrets", {
      method: "POST",
      body: JSON.stringify({ name, value: `e2e-dummy-${name}`, scope: "global" }),
    });
    expect(status, JSON.stringify(body)).toBe(201);
  }
  for (const repoUrl of [REPO_A, REPO_B, REPO_DOOMED]) {
    const { status, body } = await api("/api/repos", {
      method: "POST",
      body: JSON.stringify({
        repoUrl,
        fullName: repoUrl.replace("https://github.com/", ""),
        defaultBranch: "main",
      }),
    });
    expect(status, JSON.stringify(body)).toBe(201);
  }
  seeded = true;
}

export const ticks = (n: number, everyMs = 100) => `[[mock:ticks:${n}:${everyMs}]]`;

export async function createTask(
  api: Client,
  repoUrl: string,
  directives: string,
): Promise<string> {
  // Directives go in the title: it is rendered into the agent's prompt.
  const { status, body } = await api<{ task: { id: string } }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: `scale-out ${directives}`,
      prompt: "E2E scale-out scenario",
      repoUrl,
      agentType: "claude-code",
    }),
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return body.task.id;
}

export async function createJobRun(api: Client, name: string, directives: string): Promise<string> {
  const job = await api<{ workflow: { id: string } }>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      name,
      promptTemplate: `Scale-out Job ${directives}`,
      agentRuntime: "claude-code",
    }),
  });
  expect(job.status, JSON.stringify(job.body)).toBe(201);
  const run = await api<{ run: { id: string } }>(`/api/jobs/${job.body.workflow.id}/runs`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return run.body.run.id;
}

export async function createAgent(api: Client, slug: string, directives: string): Promise<string> {
  const { status, body } = await api<{ agent: { id: string } }>("/api/persistent-agents", {
    method: "POST",
    body: JSON.stringify({
      slug,
      name: slug,
      agentRuntime: "claude-code",
      initialPrompt: `Scale-out agent ${directives}`,
    }),
  });
  expect(status, JSON.stringify(body)).toBe(201);
  return body.agent.id;
}

export interface ExecRow {
  id: string;
  state: string | null;
  exec_state: string | null;
  attached_by: string | null;
  attach_lease_until: Date | null;
  consumed_bytes: string | number;
  cost_usd: string | null;
  error_message: string | null;
}

export async function workRun(id: string): Promise<ExecRow> {
  const [row] = await sql<ExecRow[]>`
    SELECT id, state::text AS state, exec_state, attached_by, attach_lease_until,
           consumed_bytes, cost_usd, error_message
    FROM tasks WHERE id = ${id}`;
  return row;
}

export async function openTurn(agentId: string): Promise<ExecRow | undefined> {
  const [row] = await sql<ExecRow[]>`
    SELECT id, NULL AS state, exec_state, attached_by, attach_lease_until,
           consumed_bytes, cost_usd, error_message
    FROM persistent_agent_turns
    WHERE agent_id = ${agentId} AND finished_at IS NULL
    ORDER BY turn_number DESC LIMIT 1`;
  return row;
}

export async function turns(agentId: string) {
  return sql<
    Array<{
      id: string;
      turn_number: number;
      halt_reason: string | null;
      cost_usd: string | null;
      error_message: string | null;
      finished_at: Date | null;
    }>
  >`SELECT id, turn_number, halt_reason, cost_usd, error_message, finished_at
    FROM persistent_agent_turns WHERE agent_id = ${agentId} ORDER BY turn_number`;
}

export async function agentRow(agentId: string) {
  const [row] = await sql<Array<{ state: string; total_cost_usd: string }>>`
    SELECT state::text AS state, total_cost_usd FROM persistent_agents WHERE id = ${agentId}`;
  return row;
}

/** The server (by boot index) whose live lease holds the row, or -1. */
export function holder(cluster: ApiCluster, row: ExecRow | undefined): number {
  if (!row?.attached_by || !row.attach_lease_until) return -1;
  if (new Date(row.attach_lease_until).getTime() <= Date.now()) return -1;
  const base = row.attached_by.split(":")[0];
  return cluster.servers.findIndex((s) => s.name === base);
}

/** A live server other than `not`. */
export function otherLive(cluster: ApiCluster, not: number): number {
  const i = cluster.servers.findIndex((s, idx) => s.alive && idx !== not);
  if (i < 0) throw new Error("no other live server");
  return i;
}

export async function logRows(owner: { taskId?: string; turnId?: string }) {
  return owner.taskId
    ? sql<Array<{ content: string; log_type: string | null }>>`
        SELECT content, log_type FROM task_logs WHERE task_id = ${owner.taskId}`
    : sql<Array<{ content: string; log_type: string | null }>>`
        SELECT content, log_type FROM task_logs WHERE persistent_agent_turn_id = ${owner.turnId!}`;
}

/** The tick numbers stored for a run. */
export async function tickNumbers(owner: { taskId?: string; turnId?: string }): Promise<number[]> {
  return (await logRows(owner))
    .map((r) => /^tick (\d+)$/.exec(r.content)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
}

/**
 * The run's log rows are the agent's lines, each exactly once: ticks
 * 1…n (or a contiguous prefix of them, for a run stopped mid-way), one
 * session line, one result line when it got that far.
 */
export async function expectContiguousLogs(
  owner: { taskId?: string; turnId?: string },
  n: number,
  opts: { complete?: boolean } = { complete: true },
) {
  const rows = await logRows(owner);
  const nums = await tickNumbers(owner);
  const sorted = [...nums].sort((a, b) => a - b);
  expect(new Set(nums).size, "no duplicate tick rows").toBe(nums.length);
  expect(sorted, "ticks contiguous from 1").toEqual(sorted.map((_, i) => i + 1));
  expect(rows.filter((r) => r.content.startsWith("Session started")).length).toBe(1);
  if (opts.complete !== false) {
    expect(sorted.length).toBe(n);
    expect(rows.filter((r) => r.log_type === "info" && r.content.includes("$")).length).toBe(1);
  }
}

/** Waits until the row's agent started and some of its output is stored. */
export async function waitStreaming(read: () => Promise<ExecRow | undefined>, label: string) {
  return waitFor(
    async () => {
      const row = await read();
      return row && row.exec_state === "started" && Number(row.consumed_bytes) > 0 ? row : null;
    },
    { timeoutMs: 60_000, intervalMs: 100, label: `${label} streaming` },
  );
}

/** Waits until a live server other than `not` holds the row; returns it and the time it took. */
export async function waitTakenOver(
  cluster: ApiCluster,
  read: () => Promise<ExecRow | undefined>,
  not: number,
  timeoutMs: number,
  label: string,
): Promise<{ by: number; ms: number }> {
  const t0 = Date.now();
  const by = await waitFor(
    async () => {
      const i = holder(cluster, await read());
      return i >= 0 && i !== not && cluster.servers[i].alive ? i + 1 : null;
    },
    { timeoutMs, intervalMs: 100, label: `${label} re-attached` },
  );
  return { by: by - 1, ms: Date.now() - t0 };
}

export async function waitWorkRunState(
  id: string,
  states: string[],
  label: string,
  timeoutMs = 120_000,
) {
  return waitFor(
    async () => {
      const row = await workRun(id);
      return row && states.includes(row.state ?? "") ? row : null;
    },
    { timeoutMs, intervalMs: 250, label: `${label} → ${states.join("|")}` },
  );
}

export async function waitAgentIdleAfter(agentId: string, finishedTurns: number, label: string) {
  return waitFor(
    async () => {
      const [agent, ts] = await Promise.all([agentRow(agentId), turns(agentId)]);
      const done = ts.filter((t) => t.finished_at).length;
      return agent.state === "idle" && done >= finishedTurns ? { agent, turns: ts } : null;
    },
    { timeoutMs: 120_000, intervalMs: 250, label: `${label} idle after ${finishedTurns} turn(s)` },
  );
}

/**
 * Waits until the agent is idle after a turn that ran to its end, and
 * returns it. Before it, the only turns allowed are ones whose starting
 * server died before their agent started: the reconciler halts such a turn
 * (it never ran: no cost, no logs) and the agent's next turn does the work —
 * recovery, as a task set up by a dead server is queued again.
 */
export async function waitAgentTurnDone(agentId: string, label: string) {
  const { agent, turns: ts } = await waitFor(
    async () => {
      const [a, t] = await Promise.all([agentRow(agentId), turns(agentId)]);
      return a.state === "idle" && t.some((x) => x.halt_reason === "natural")
        ? { agent: a, turns: t }
        : null;
    },
    { timeoutMs: 120_000, intervalMs: 250, label: `${label} idle after a natural turn` },
  ).catch(async (err) => {
    // Say where the agent is stuck.
    const [a] = await sql`
      SELECT state::text AS state, consecutive_failures, last_failure_reason, updated_at
      FROM persistent_agents WHERE id = ${agentId}`;
    const t = await sql`
      SELECT turn_number, halt_reason, error_message, exec_state, attached_by,
             attach_lease_until, pod_id, created_at, finished_at
      FROM persistent_agent_turns WHERE agent_id = ${agentId} ORDER BY turn_number`;
    const pods = await sql`
      SELECT id, state, pod_id, pod_name, created_at, updated_at, error_message
      FROM agent_pods WHERE pool = 'persistent-agent' AND pool_key = ${agentId}`;
    const msgs = await sql`
      SELECT id, turn_id, received_at FROM persistent_agent_messages WHERE agent_id = ${agentId}`;
    throw new Error(
      `${String(err)}\nagent: ${JSON.stringify(a)}\nturns: ${JSON.stringify(t)}\npods: ${JSON.stringify(pods)}\nmessages: ${JSON.stringify(msgs)}`,
    );
  });
  const natural = ts.filter((t) => t.halt_reason === "natural");
  expect(natural, JSON.stringify(ts)).toHaveLength(1);
  for (const t of ts.filter((x) => x.halt_reason !== "natural")) {
    expect(t.halt_reason, JSON.stringify(ts)).toBe("error");
    expect(t.error_message, JSON.stringify(ts)).toMatch(/went away before its agent started/);
    expect(t.cost_usd).toBeNull();
    expect(await logRows({ turnId: t.id })).toHaveLength(0);
  }
  return { agent, turn: natural[0] };
}

/** The fake agent's exit file for a run (its exit code), or null while it runs. */
export function exitCodeOf(cluster: ApiCluster, runId: string): number | null {
  const path = join(cluster.fakeRuntimeDir, "runs", runId, "exit");
  return existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : null;
}

/** Fails the test with the servers' log tails when `fn` throws. */
export async function withLogs<T>(cluster: ApiCluster, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const tails = cluster.servers
      .map((s) => `--- ${s.name} ---\n${s.handle.logs().split("\n").slice(-80).join("\n")}`)
      .join("\n");
    throw new Error(`${String(err)}\n${tails}`);
  }
}

/**
 * No run was failed or flagged by a recovery path. (A task whose server
 * died while it was being set up is queued again — `provisioning_interrupted`
 * — and runs to its end: that is recovery working, not a failure.)
 */
export async function noRecoveryFailures(ids: string[]) {
  const rows = await sql<Array<{ trigger: string }>>`
    SELECT trigger FROM task_events
    WHERE task_id = ANY(${ids}::uuid[])
      AND trigger IN ('execution_interrupted', 'startup_recovery_required', 'run_lost',
                      'stall_detected', 'running_pod_died', 'provisioning_pod_died')`;
  expect(rows.map((r) => r.trigger)).toEqual([]);
}

// ── One server: kill it, boot another ────────────────────────────────────────
