// Scale-out: runs outlive their server. Setup and helpers in scale-out-runs.shared.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiCluster, type ApiCluster } from "../src/test-utils/e2e/api-cluster.js";
import {
  CLUSTER_ENV,
  REPO_A,
  REPO_B,
  FAKE_RUNTIME_DIR,
  seed,
  ticks,
  createTask,
  createJobRun,
  createAgent,
  workRun,
  openTurn,
  holder,
  expectContiguousLogs,
  waitStreaming,
  waitWorkRunState,
  waitAgentIdleAfter,
  exitCodeOf,
  withLogs,
  noRecoveryFailures,
  cleanup,
} from "./scale-out-runs.shared.js";

afterAll(cleanup);

describe("one server", () => {
  let cluster: ApiCluster;

  beforeAll(async () => {
    cluster = await startApiCluster({
      size: 1,
      env: CLUSTER_ENV,
      fakeRuntimeDir: FAKE_RUNTIME_DIR,
    });
    await seed(cluster.any());
  }, 240_000);

  afterAll(async () => {
    await cluster?.stop();
  });

  it("(1, 11) a Repo Task, a Job run and an agent turn survive SIGKILL of their only server", async () => {
    await withLogs(cluster, async () => {
      const api = cluster.client(0);
      const N = 60;
      const taskId = await createTask(api, REPO_A, `[[mock:pr]] ${ticks(N)}`);
      const runId = await createJobRun(api, "kill-1 job", ticks(N));
      const agentId = await createAgent(api, "kill-1-agent", ticks(N));

      await waitStreaming(() => workRun(taskId), "task");
      await waitStreaming(() => workRun(runId), "job run");
      const turn = await waitStreaming(() => openTurn(agentId), "turn");

      await cluster.kill(0, "SIGKILL");
      // The agents go on in their pods with nobody streaming them.
      expect(exitCodeOf(cluster, taskId)).toBeNull();
      await cluster.add();

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      expect(task.cost_usd).toBe("0.0123");
      expect(task.exec_state).toBe("exited");
      await expectContiguousLogs({ taskId }, N);

      const run = await waitWorkRunState(runId, ["completed", "failed"], "job run");
      expect(run.state).toBe("completed");
      expect(run.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId: runId }, N);

      const { agent, turns: ts } = await waitAgentIdleAfter(agentId, 1, "agent");
      expect(ts[0].halt_reason, JSON.stringify(ts)).toBe("natural");
      expect(ts[0].cost_usd).toBe("0.0123");
      expect(agent.total_cost_usd).toBe("0.0123");
      await expectContiguousLogs({ turnId: turn.id }, N);

      await noRecoveryFailures([taskId, runId]);
    });
  }, 180_000);

  it("(12) booting a server while runs are in flight fails nothing and takes nothing", async () => {
    await withLogs(cluster, async () => {
      const live = cluster.live()[0];
      const i = cluster.servers.indexOf(live);
      const api = cluster.client(i);
      // Keep both agents running through a cold tsx/API boot on busy runners.
      const N = 200;
      const taskId = await createTask(api, REPO_B, `[[mock:pr]] ${ticks(N)}`);
      const runId = await createJobRun(api, "boot-12 job", ticks(N));
      await waitStreaming(() => workRun(taskId), "task");
      await waitStreaming(() => workRun(runId), "job run");

      const booted = await cluster.add();
      const bootedIndex = cluster.servers.indexOf(booted);
      // The new server's boot left the runs where they were.
      for (const id of [taskId, runId]) {
        const row = await workRun(id);
        expect(["running", "provisioning"]).toContain(row.state);
        expect(holder(cluster, row)).toBe(i);
      }

      const task = await waitWorkRunState(
        taskId,
        ["pr_opened", "failed", "needs_attention"],
        "task",
      );
      expect(task.state).toBe("pr_opened");
      expect(task.cost_usd).toBe("0.0123");
      await expectContiguousLogs({ taskId }, N);
      const run = await waitWorkRunState(runId, ["completed", "failed"], "job run");
      expect(run.state).toBe("completed");
      await expectContiguousLogs({ taskId: runId }, N);
      await noRecoveryFailures([taskId, runId]);
      expect(bootedIndex).toBeGreaterThan(i);
    });
  }, 180_000);
});

// ── Three servers ────────────────────────────────────────────────────────────
