// Scale-out: runs outlive their server. Setup and helpers in scale-out-runs.shared.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeContainerRuntime } from "@optio/container-runtime";
import { waitFor } from "../src/test-utils/e2e/api-server.js";
import { startApiCluster, type ApiCluster } from "../src/test-utils/e2e/api-cluster.js";
import {
  MAX_CONCURRENT,
  CLUSTER_ENV,
  REPO_A,
  REPO_B,
  REPO_DOOMED,
  sql,
  FAKE_RUNTIME_DIR,
  seed,
  ticks,
  createTask,
  createJobRun,
  createAgent,
  workRun,
  openTurn,
  turns,
  agentRow,
  holder,
  otherLive,
  logRows,
  tickNumbers,
  expectContiguousLogs,
  waitStreaming,
  waitTakenOver,
  waitWorkRunState,
  waitAgentIdleAfter,
  waitAgentTurnDone,
  exitCodeOf,
  withLogs,
  noRecoveryFailures,
  cleanup,
} from "./scale-out-runs.shared.js";

afterAll(cleanup);

describe("three servers", () => {
  let cluster: ApiCluster;

  /** Keeps three servers up between cases that kill one. */
  async function replenish() {
    while (cluster.live().length < 3) await cluster.add();
  }

  beforeAll(async () => {
    cluster = await startApiCluster({
      size: 3,
      env: CLUSTER_ENV,
      fakeRuntimeDir: FAKE_RUNTIME_DIR,
    });
    await seed(cluster.any());
  }, 300_000);

  afterAll(async () => {
    await cluster?.stop();
  });

  it("(2) when the attached server is killed, another attaches within 10 s and the run completes", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      // Keep streaming beyond the full 10 s takeover window. An 8 s run can
      // settle and clear its lease before polling observes the new holder.
      const N = 200;
      const taskId = await createTask(cluster.client(0), REPO_A, `[[mock:pr]] ${ticks(N)}`);
      const row = await waitStreaming(() => workRun(taskId), "task");
      const attached = holder(cluster, row);
      expect(attached).toBeGreaterThanOrEqual(0);

      const before = (await tickNumbers({ taskId })).length;
      await cluster.kill(attached, "SIGKILL");
      const { ms } = await waitTakenOver(cluster, () => workRun(taskId), attached, 10_000, "task");
      expect(ms).toBeLessThan(10_000);

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      expect(task.cost_usd).toBe("0.0123");
      // Changed hands mid-run: some ticks were stored before, the rest after.
      expect(before).toBeLessThan(N);
      await expectContiguousLogs({ taskId }, N);
    });
  }, 180_000);

  it("(3) ten runs across kinds, one server killed: all complete, limits never exceeded", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const api = cluster.any();
      const N = 30;
      // Keep the first wave alive while the independent persistent-agent
      // queue admits its turns, including on a loaded CI runner.
      const output = ticks(N, 250);
      const taskIds = [
        ...(await Promise.all(
          [0, 1, 2, 3].map(() => createTask(api, REPO_A, `[[mock:pr]] ${output}`)),
        )),
        ...(await Promise.all([0, 1].map(() => createTask(api, REPO_B, `[[mock:pr]] ${output}`)))),
      ];
      const runIds = await Promise.all([0, 1].map((k) => createJobRun(api, `ten-${k}`, output)));
      const agentIds = await Promise.all(
        [0, 1].map((k) => createAgent(api, `ten-agent-${k}`, output)),
      );

      // The limits, polled from the database the whole time.
      let maxGlobal = 0;
      const maxPerRepo: Record<string, number> = {};
      let polling = true;
      const poller = (async () => {
        while (polling) {
          const rows = await sql<Array<{ repo_url: string; n: number }>>`
            SELECT repo_url, count(*)::int AS n FROM repo_tasks
            WHERE state IN ('provisioning', 'running') GROUP BY repo_url`;
          maxGlobal = Math.max(
            maxGlobal,
            rows.reduce((a, r) => a + r.n, 0),
          );
          for (const r of rows) maxPerRepo[r.repo_url] = Math.max(maxPerRepo[r.repo_url] ?? 0, r.n);
          await new Promise((r) => setTimeout(r, 250));
        }
      })();

      try {
        // This case exercises durable runs surviving their server. Do not kill
        // in the tiny claim-before-turn window: that deliberately uses the
        // five-minute NO_OPEN_TURN_GRACE_MS, longer than this case's wait.
        // The no-turn grace is covered in reconcile-attachment.test.ts; case
        // 21 below covers a held turn whose server dies while making its pod.
        await waitFor(
          async () => {
            const [rows, agentTurns] = await Promise.all([
              Promise.all(taskIds.map(workRun)),
              Promise.all(agentIds.map(turns)),
            ]);
            return rows.filter((r) => r.exec_state === "started" && Number(r.consumed_bytes) > 0)
              .length >= 2 && agentTurns.every((ts) => ts.length > 0)
              ? true
              : null;
          },
          {
            timeoutMs: 60_000,
            intervalMs: 100,
            label: "first wave streaming and agent turns admitted",
          },
        );
        const counts = new Map<number, number>();
        for (const id of [...taskIds, ...runIds]) {
          const h = holder(cluster, await workRun(id));
          if (h >= 0) counts.set(h, (counts.get(h) ?? 0) + 1);
        }
        const victim = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
        await cluster.kill(victim, "SIGKILL");

        for (const id of taskIds) {
          const task = await waitWorkRunState(
            id,
            ["pr_opened", "failed", "needs_attention"],
            "task",
            240_000,
          );
          expect(task.state).toBe("pr_opened");
          expect(task.cost_usd).toBe("0.0123");
          await expectContiguousLogs({ taskId: id }, N);
        }
        for (const id of runIds) {
          const run = await waitWorkRunState(id, ["completed", "failed"], "job run", 240_000);
          expect(run.state).toBe("completed");
          expect(run.cost_usd).toBe("0.0123");
          await expectContiguousLogs({ taskId: id }, N);
        }
        for (const id of agentIds) {
          const { agent, turn } = await waitAgentTurnDone(id, "agent");
          expect(agent.total_cost_usd).toBe("0.0123");
          await expectContiguousLogs({ turnId: turn.id }, N);
        }
      } finally {
        polling = false;
        await poller;
      }

      expect(maxGlobal).toBeLessThanOrEqual(MAX_CONCURRENT);
      for (const repo of [REPO_A, REPO_B]) expect(maxPerRepo[repo] ?? 0).toBeLessThanOrEqual(2);
      await noRecoveryFailures(taskIds);
    });
  }, 420_000);

  it("(4, 11) a cancel through a server not attached to the run stops its agent — task, Job run, agent turn", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 300;
      const taskId = await createTask(cluster.any(), REPO_A, ticks(N));
      const runId = await createJobRun(cluster.any(), "cancel-4 job", ticks(N));
      const agentId = await createAgent(cluster.any(), "cancel-4-agent", ticks(N));
      const taskRow = await waitStreaming(() => workRun(taskId), "task");
      const runRow = await waitStreaming(() => workRun(runId), "job run");
      const turn = await waitStreaming(() => openTurn(agentId), "turn");

      const cancelTask = await cluster.client(otherLive(cluster, holder(cluster, taskRow)))(
        `/api/tasks/${taskId}/cancel`,
        { method: "POST", body: "{}" },
      );
      expect(cancelTask.status).toBe(200);
      const cancelRun = await cluster.client(otherLive(cluster, holder(cluster, runRow)))(
        `/api/workflow-runs/${runId}/cancel`,
        { method: "POST", body: "{}" },
      );
      expect(cancelRun.status).toBe(200);
      // A persistent agent's cancel is its archive.
      const archive = await cluster.client(otherLive(cluster, holder(cluster, turn)))(
        `/api/persistent-agents/${agentId}/control`,
        { method: "POST", body: JSON.stringify({ intent: "archive" }) },
      );
      expect(archive.status).toBe(200);

      // Each agent got the signal (exit 143) long before its N ticks.
      for (const [kind, id] of [
        ["task", taskId],
        ["job run", runId],
        ["agent turn", turn.id],
      ] as const) {
        await waitFor(async () => (exitCodeOf(cluster, id) === 143 ? true : null), {
          timeoutMs: 30_000,
          label: `the ${kind}'s agent stopped (${id})`,
        });
      }

      const task = await waitWorkRunState(taskId, ["cancelled"], "task");
      expect(task.state).toBe("cancelled");
      const run = await waitWorkRunState(runId, ["failed"], "job run");
      expect(run.error_message).toBe("Cancelled by user");
      await waitFor(async () => ((await agentRow(agentId)).state === "archived" ? true : null), {
        label: "agent archived",
      });
      await waitFor(async () => ((await turns(agentId))[0]?.finished_at ? true : null), {
        label: "turn halted",
      });

      // The runs settled where they stopped: every stored tick once, far short of N.
      for (const owner of [{ taskId }, { taskId: runId }, { turnId: turn.id }]) {
        await waitFor(
          async () => {
            const row = owner.turnId
              ? await sql`SELECT exec_state FROM persistent_agent_turns WHERE id = ${owner.turnId}`
              : await sql`SELECT exec_state FROM tasks WHERE id = ${owner.taskId!}`;
            return row[0]?.exec_state === "exited" ? true : null;
          },
          { label: "settled" },
        );
        await expectContiguousLogs(owner, N, { complete: false });
        expect((await tickNumbers(owner)).length).toBeLessThan(N);
      }
    });
  }, 180_000);

  it("(5, 11) a message through a server not attached to the run reaches its agent", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 40;
      const taskId = await createTask(
        cluster.any(),
        REPO_B,
        `[[mock:pr]] [[mock:echo-stdin]] ${ticks(N)}`,
      );
      const row = await waitStreaming(() => workRun(taskId), "task");
      const via = otherLive(cluster, holder(cluster, row));
      const sent = await cluster.client(via)(`/api/tasks/${taskId}/message`, {
        method: "POST",
        body: JSON.stringify({ content: "hello from elsewhere", mode: "soft" }),
      });
      expect(sent.status).toBe(202);

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      const contents = (await logRows({ taskId })).map((r) => r.content);
      expect(contents).toContain("stdin: hello from elsewhere");
      expect(contents.filter((c) => c === "stdin: hello from elsewhere")).toHaveLength(1);
      const [msg] = await sql<Array<{ delivered_at: Date | null; delivery_error: string | null }>>`
        SELECT delivered_at, delivery_error FROM task_messages WHERE task_id = ${taskId}`;
      expect(msg.delivery_error).toBeNull();
      expect(msg.delivered_at).not.toBeNull();
      await expectContiguousLogs({ taskId }, N);

      // A persistent agent takes messages through its inbox: one posted to a
      // server not attached to the running turn wakes the agent's next turn.
      const agentId = await createAgent(cluster.any(), "message-5-agent", ticks(N));
      const turn = await waitStreaming(() => openTurn(agentId), "turn");
      const agentVia = otherLive(cluster, holder(cluster, turn));
      const posted = await cluster.client(agentVia)(`/api/persistent-agents/${agentId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: "second thought" }),
      });
      expect(posted.status).toBe(202);
      const { turns: ts } = await waitAgentIdleAfter(agentId, 2, "agent");
      const [second] = await sql<Array<{ prompt_used: string }>>`
        SELECT prompt_used FROM persistent_agent_turns WHERE id = ${ts[1].id}`;
      expect(second.prompt_used).toContain("second thought");
      await expectContiguousLogs({ turnId: turn.id }, N);
    });
  }, 180_000);

  it("(9) SIGTERM to the attached server hands the run to another in under 5 s", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const N = 80;
      const taskId = await createTask(cluster.any(), REPO_A, `[[mock:pr]] ${ticks(N)}`);
      const row = await waitStreaming(() => workRun(taskId), "task");
      const attached = holder(cluster, row);
      expect(attached).toBeGreaterThanOrEqual(0);

      const stopping = cluster.kill(attached, "SIGTERM");
      const { ms } = await waitTakenOver(cluster, () => workRun(taskId), attached, 5_000, "task");
      expect(ms).toBeLessThan(5_000);
      await stopping;

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      expect(task.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId }, N);
    });
  }, 180_000);

  it("(10) the pod going away mid-run fails the run with the pod's reason", async () => {
    await withLogs(cluster, async () => {
      await replenish();
      const taskId = await createTask(cluster.any(), REPO_DOOMED, ticks(300));
      await waitStreaming(() => workRun(taskId), "task");
      const [pod] = await sql<Array<{ pod_id: string | null; pod_name: string }>>`
        SELECT p.pod_id, p.pod_name FROM agent_pods p
        JOIN tasks t ON t.last_pod_id = p.id WHERE t.id = ${taskId}`;
      const fake = new FakeContainerRuntime({ dir: cluster.fakeRuntimeDir });
      await fake.destroy({ id: pod.pod_id ?? pod.pod_name, name: pod.pod_name });

      const task = await waitWorkRunState(
        taskId,
        ["failed", "cancelled", "completed", "pr_opened", "needs_attention"],
        "task",
        60_000,
      );
      expect(task.state).toBe("failed");
      expect(task.error_message).toMatch(/pod/i);
      await expectContiguousLogs({ taskId }, 300, { complete: false });
    });
  }, 120_000);
});

// ── Resets, review runs, edits and settling ──────────────────────────────────
