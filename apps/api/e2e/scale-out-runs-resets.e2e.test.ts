// Scale-out: runs outlive their server. Setup and helpers in scale-out-runs.shared.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Queue } from "bullmq";
import { getBullMQOptions } from "../src/services/redis-config.js";
import { waitFor } from "../src/test-utils/e2e/api-server.js";
import { startApiCluster, type ApiCluster } from "../src/test-utils/e2e/api-cluster.js";
import {
  CLUSTER_ENV,
  REPO_A,
  REPO_B,
  sql,
  FAKE_RUNTIME_DIR,
  seed,
  ticks,
  createTask,
  createAgent,
  type ExecRow,
  workRun,
  holder,
  logRows,
  tickNumbers,
  expectContiguousLogs,
  waitStreaming,
  waitTakenOver,
  waitWorkRunState,
  waitAgentIdleAfter,
  exitCodeOf,
  withLogs,
  noRecoveryFailures,
  cleanup,
} from "./scale-out-runs.shared.js";

afterAll(cleanup);

describe("resets, review runs, edits and settling", () => {
  let cluster: ApiCluster;
  let reviewQueue: Queue;
  /** A pause right after a run's exit is recorded: a window to SIGTERM a server in. */
  const SETTLE_PAUSE_MS = 3_000;

  async function replenish() {
    while (cluster.live().length < 2) await cluster.add();
  }

  beforeAll(async () => {
    cluster = await startApiCluster({
      size: 2,
      fakeRuntimeDir: FAKE_RUNTIME_DIR,
      env: {
        ...CLUSTER_ENV,
        OPTIO_SETTLE_PAUSE_MS: String(SETTLE_PAUSE_MS),
        // A run's output line FAULT-ONCE fails the log write of the job that
        // started it; FAULT-ALWAYS fails every job's (cases 18, 19).
        OPTIO_TEST_STREAM_FAULT_FIRST: "FAULT-ONCE",
        OPTIO_TEST_STREAM_FAULT: "FAULT-ALWAYS",
      },
    });
    await seed(cluster.any());
    reviewQueue = new Queue("pr-review-runs", getBullMQOptions());
  }, 300_000);

  afterAll(async () => {
    await reviewQueue?.close();
    await cluster?.stop();
  });

  let prNumber = 100;
  /** A review of a PR on REPO_A with one run queued for the review worker. */
  async function createReviewRun(directives: string) {
    const [repo] = await sql<Array<{ workspace_id: string | null }>>`
      SELECT workspace_id FROM repos WHERE repo_url = ${REPO_A}`;
    const n = prNumber++;
    const [review] = await sql<Array<{ id: string }>>`
      INSERT INTO pr_reviews (pr_url, pr_number, repo_owner, repo_name, repo_url, head_sha, state, workspace_id)
      VALUES (${`${REPO_A}/pull/${n}`}, ${n}, 'e2e-org', 'scale-a', ${REPO_A}, 'deadbeef', 'reviewing', ${repo.workspace_id})
      RETURNING id`;
    const [run] = await sql<Array<{ id: string }>>`
      INSERT INTO pr_review_runs (pr_review_id, kind, state, prompt, metadata)
      VALUES (${review.id}, 'initial', 'queued', ${`Review the PR ${directives}`}, '{}'::jsonb)
      RETURNING id`;
    await reviewQueue.add("process-pr-review-run", { runId: run.id }, { jobId: run.id });
    return { reviewId: review.id, runId: run.id };
  }

  async function reviewRun(runId: string): Promise<ExecRow> {
    const [row] = await sql<ExecRow[]>`
      SELECT id, state::text AS state, exec_state, attached_by, attach_lease_until,
             consumed_bytes, cost_usd, error_message
      FROM pr_review_runs WHERE id = ${runId}`;
    return row;
  }

  async function review(reviewId: string) {
    const [row] = await sql<
      Array<{ state: string; summary: string | null; verdict: string | null }>
    >`
      SELECT state::text AS state, summary, verdict FROM pr_reviews WHERE id = ${reviewId}`;
    return row;
  }

  async function reviewEvents(reviewId: string, trigger: string) {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pr_review_events
      WHERE pr_review_id = ${reviewId} AND trigger = ${trigger}`;
    return rows[0].n;
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("(13) a force-redo of a running task stops its agent; only the new attempt's logs remain", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 40;
      const taskId = await createTask(cluster.any(), REPO_B, `[[mock:pr]] ${ticks(N)}`);
      await waitStreaming(() => workRun(taskId), "task");
      const [{ exec_pid: oldPid }] = await sql<Array<{ exec_pid: number }>>`
        SELECT exec_pid FROM tasks WHERE id = ${taskId}`;
      expect(alive(oldPid)).toBe(true);

      const redo = await cluster.any()(`/api/tasks/${taskId}/force-redo`, {
        method: "POST",
        body: "{}",
      });
      expect(redo.status).toBe(200);
      // The old attempt's agent is stopped (its TERM: the redo's, or its job's).
      await waitFor(async () => (alive(oldPid) ? null : true), {
        timeoutMs: 10_000,
        label: "the old attempt's agent stopped",
      });

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      // One attempt's spend (the redo cleared the old one's), one attempt's lines.
      expect(task.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId }, N);
      const [{ exec_pid: newPid }] = await sql<Array<{ exec_pid: number }>>`
        SELECT exec_pid FROM tasks WHERE id = ${taskId}`;
      expect(newPid).not.toBe(oldPid);
      const events = await sql<Array<{ trigger: string }>>`
        SELECT trigger FROM task_events WHERE task_id = ${taskId} AND to_state = 'pr_opened'`;
      expect(events).toHaveLength(1);
    });
  }, 180_000);

  it("(14) a review cancelled while its run is being set up: run cancelled, agent stopped, nothing written", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const { reviewId, runId } = await createReviewRun(`[[mock:slow-start:4000]] ${ticks(20)}`);
      // The start exec is under way (the fake's run directory exists): cancel.
      await waitFor(
        async () => (existsSync(join(cluster.fakeRuntimeDir, "runs", runId)) ? true : null),
        { timeoutMs: 60_000, intervalMs: 100, label: "the review run's start under way" },
      );
      expect((await reviewRun(runId)).state).toBe("provisioning");
      const cancel = await cluster.any()(`/api/pr-reviews/${reviewId}/cancel`, {
        method: "POST",
        body: "{}",
      });
      expect(cancel.status).toBeLessThan(300);
      await waitFor(async () => ((await review(reviewId)).state === "cancelled" ? true : null), {
        timeoutMs: 30_000,
        label: "review cancelled",
      });

      // The agent the start launched is stopped (TERM: 143), not left running.
      await waitFor(async () => (exitCodeOf(cluster, runId) === 143 ? true : null), {
        timeoutMs: 30_000,
        label: "the review run's agent stopped",
      });
      const run = await reviewRun(runId);
      expect(run.state).toBe("cancelled");
      // Give a stray finish its chance to write anything: nothing comes.
      await new Promise((r) => setTimeout(r, 2_000));
      const after = await review(reviewId);
      expect(after.state).toBe("cancelled");
      expect(after.summary).toBeNull();
      expect(after.verdict).toBeNull();
      expect(await reviewEvents(reviewId, "agent_drafted")).toBe(0);
      expect((await reviewRun(runId)).state).toBe("cancelled");
      const logs = await sql`SELECT 1 FROM task_logs WHERE pr_review_run_id = ${runId}`;
      expect(logs).toHaveLength(0);
    });
  }, 180_000);

  it("(15) a Job edited from an agent to a command mid-run: the re-attach still reads it as the agent", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 60;
      const job = await cluster.any()<{ workflow: { id: string } }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          name: "edit-15 job",
          promptTemplate: `Scale-out Job ${ticks(N)}`,
          agentRuntime: "claude-code",
        }),
      });
      expect(job.status, JSON.stringify(job.body)).toBe(201);
      const jobId = job.body.workflow.id;
      const started = await cluster.any()<{ run: { id: string } }>(`/api/jobs/${jobId}/runs`, {
        method: "POST",
        body: "{}",
      });
      expect(started.status).toBe(201);
      const runId = started.body.run.id;
      const row = await waitStreaming(() => workRun(runId), "job run");

      const edit = await cluster.any()(`/api/jobs/${jobId}`, {
        method: "PATCH",
        body: JSON.stringify({ agentRuntime: "shell", promptTemplate: "echo edited" }),
      });
      expect(edit.status).toBe(200);

      const attached = holder(cluster, row);
      expect(attached).toBeGreaterThanOrEqual(0);
      await cluster.kill(attached, "SIGKILL");
      await waitTakenOver(cluster, () => workRun(runId), attached, 15_000, "job run");

      const run = await waitWorkRunState(runId, ["completed", "failed"], "job run");
      expect(run.error_message).toBeNull();
      expect(run.state).toBe("completed");
      expect(run.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId: runId }, N);
    });
  }, 180_000);

  it("(17) a failed run's message carries the tail of its agent's stderr", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const taskId = await createTask(
        cluster.any(),
        REPO_B,
        "[[mock:fail]] [[mock:stderr:claude: the model refused the key]]",
      );
      const task = await waitWorkRunState(
        taskId,
        ["failed", "pr_opened", "needs_attention", "completed"],
        "task",
      );
      expect(task.state).toBe("failed");
      expect(task.error_message).toContain("Mock agent failure");
      expect(task.error_message).toContain("Agent stderr (last 8 KB):");
      expect(task.error_message).toContain("claude: the model refused the key");
    });
  }, 120_000);

  it("(18) a log write that fails once mid-stream: the run is re-attached and completes, its agent untouched", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 40;
      const taskId = await createTask(
        cluster.any(),
        REPO_A,
        `[[mock:pr]] ${ticks(N)} [[mock:mark:10:FAULT-ONCE]]`,
      );
      await waitStreaming(() => workRun(taskId), "task");
      const [{ exec_pid: pid }] = await sql<Array<{ exec_pid: number }>>`
        SELECT exec_pid FROM tasks WHERE id = ${taskId}`;

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      expect(task.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId }, N);
      // The job that started the run always fails on this line, so another
      // job — an attach — stored it, once.
      const marks = (await logRows({ taskId })).filter((r) => r.content === "FAULT-ONCE");
      expect(marks).toHaveLength(1);
      // The same agent ran to its end (exit 0): the failure only moved the
      // run to another job, it never stopped or restarted the agent.
      const [{ exec_pid: after }] = await sql<Array<{ exec_pid: number }>>`
        SELECT exec_pid FROM tasks WHERE id = ${taskId}`;
      expect(after).toBe(pid);
      expect(exitCodeOf(cluster, taskId)).toBe(0);
      await noRecoveryFailures([taskId]);
    });
  }, 180_000);

  it("(19) a log write that fails every time: after 3 failed attaches the run fails and its agent is stopped", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const job = await cluster.any()<{ workflow: { id: string } }>("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          name: "fault-19 job",
          promptTemplate: `Scale-out Job ${ticks(600)} [[mock:mark:5:FAULT-ALWAYS]]`,
          agentRuntime: "claude-code",
          maxRetries: 0,
        }),
      });
      expect(job.status, JSON.stringify(job.body)).toBe(201);
      const started = await cluster.any()<{ run: { id: string } }>(
        `/api/jobs/${job.body.workflow.id}/runs`,
        { method: "POST", body: "{}" },
      );
      expect(started.status).toBe(201);
      const runId = started.body.run.id;

      const run = await waitWorkRunState(runId, ["completed", "failed"], "job run", 120_000);
      expect(run.state).toBe("failed");
      expect(run.error_message).toContain("Attaching to the run failed 3 times in a row");
      expect(run.error_message).toContain("FAULT-ALWAYS");
      const [meta] = await sql<Array<{ failures: number }>>`
        SELECT (metadata->>'attachFailures')::int AS failures FROM tasks WHERE id = ${runId}`;
      expect(meta.failures).toBe(3);
      // The agent, still ticking (600 of them), was stopped.
      await waitFor(async () => (exitCodeOf(cluster, runId) === 143 ? true : null), {
        timeoutMs: 30_000,
        label: "the run's agent stopped",
      });
      // Nothing past the failing line was ever stored (its batch — tick 5
      // too, when they came in one chunk — rolled back each time): a
      // contiguous prefix of the ticks, each once.
      await expectContiguousLogs({ taskId: runId }, 600, { complete: false });
      expect((await tickNumbers({ taskId: runId })).length).toBeLessThanOrEqual(5);
    });
  }, 180_000);

  it("(20) an agent pod abandoned mid-creation is taken over and the agent's next turn runs", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const agentId = await createAgent(cluster.any(), "abandoned-20-agent", ticks(5));
      await waitAgentIdleAfter(agentId, 1, "agent");
      const [before] = await sql<Array<{ id: string }>>`
        SELECT id FROM agent_pods WHERE pool = 'persistent-agent' AND pool_key = ${agentId}`;
      // As a server that died between the pod's row and the pod leaves it:
      // provisioning, never to be marked ready.
      await sql`
        UPDATE agent_pods SET state = 'provisioning', pod_name = NULL, pod_id = NULL,
               created_at = now(), updated_at = now()
        WHERE id = ${before.id}`;
      const posted = await cluster.any()(`/api/persistent-agents/${agentId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: "carry on" }),
      });
      expect(posted.status).toBe(202);

      // Taken over within the stale age (15 s here), not stuck behind it.
      const t0 = Date.now();
      const { turns: ts } = await waitAgentIdleAfter(agentId, 2, "agent");
      expect(Date.now() - t0).toBeLessThan(60_000);
      expect(ts.map((t) => t.halt_reason)).toEqual(["natural", "natural"]);
      const pods = await sql<Array<{ id: string; state: string }>>`
        SELECT id, state FROM agent_pods WHERE pool = 'persistent-agent' AND pool_key = ${agentId}`;
      expect(pods).toHaveLength(1);
      expect(pods[0].id).not.toBe(before.id);
      expect(pods[0].state).toBe("ready");
    });
  }, 180_000);

  it("(16) SIGTERM while a review run settles: it finishes on that server, once", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const { reviewId, runId } = await createReviewRun(ticks(10));
      // Its exit is recorded and the run is still settling (the pause).
      const row = await waitFor(
        async () => {
          const r = await reviewRun(runId);
          return r && r.state === "running" && r.exec_state === "exited" ? r : null;
        },
        { timeoutMs: 60_000, intervalMs: 100, label: "review run settling" },
      );
      const settling = holder(cluster, row);
      expect(settling).toBeGreaterThanOrEqual(0);
      // Who holds the run while that server shuts down: only it, until the
      // run is closed — never another server finishing it a second time.
      const holders = new Set<string>();
      let watching = true;
      const watcher = (async () => {
        while (watching) {
          const r = await reviewRun(runId);
          if (r.attached_by) holders.add(r.attached_by.split(":")[0]);
          await new Promise((res) => setTimeout(res, 50));
        }
      })();
      try {
        await cluster.kill(settling, "SIGTERM");
      } finally {
        watching = false;
        await watcher;
      }
      expect([...holders]).toEqual([cluster.servers[settling].name]);

      // The SIGTERMed server finished it before going: done when it was gone.
      const done = await reviewRun(runId);
      expect(done.state).toBe("completed");
      expect(done.cost_usd).toBe("0.0123");
      expect(done.attached_by).toBeNull();
      await waitFor(async () => ((await review(reviewId)).state === "ready" ? true : null), {
        timeoutMs: 30_000,
        label: "review drafted",
      });
      // No other server finished it again.
      await new Promise((r) => setTimeout(r, 3 * 1_000));
      expect(await reviewEvents(reviewId, "agent_drafted")).toBe(1);
      expect((await reviewRun(runId)).cost_usd).toBe("0.0123");
      const tickRows = await sql<Array<{ content: string }>>`
        SELECT content FROM task_logs WHERE pr_review_run_id = ${runId} AND content LIKE 'tick %'`;
      expect(tickRows).toHaveLength(10);
    });
  }, 180_000);
});

// ── A server killed while it makes an agent's pod ───────────────────────────
