// Scale-out: runs outlive their server. Setup and helpers in scale-out-runs.shared.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "../src/test-utils/e2e/api-server.js";
import { startApiCluster, type ApiCluster } from "../src/test-utils/e2e/api-cluster.js";
import {
  CLUSTER_ENV,
  sql,
  FAKE_RUNTIME_DIR,
  seed,
  ticks,
  createAgent,
  openTurn,
  turns,
  expectContiguousLogs,
  waitAgentTurnDone,
  withLogs,
  cleanup,
} from "./scale-out-runs.shared.js";

afterAll(cleanup);

describe("slow pods", () => {
  let cluster: ApiCluster;

  beforeAll(async () => {
    cluster = await startApiCluster({
      size: 1,
      // Every pod takes seconds to make: room to kill the server making one.
      env: { ...CLUSTER_ENV, OPTIO_FAKE_CREATE_DELAY_MS: "4000" },
      fakeRuntimeDir: FAKE_RUNTIME_DIR,
    });
    await seed(cluster.any());
  }, 240_000);

  afterAll(async () => {
    await cluster?.stop();
  });

  it("(21) the server making an agent's pod is killed: another halts its turn and the next one runs", async () => {
    await withLogs(cluster, async () => {
      const agentId = await createAgent(cluster.client(0), "slow-pod-21-agent", ticks(5));
      // The worker holds the turn while the pod is made.
      const held = await waitFor(
        async () => {
          const [turn, [pod]] = await Promise.all([
            openTurn(agentId),
            sql<Array<{ state: string }>>`
              SELECT state FROM agent_pods
              WHERE pool = 'persistent-agent' AND pool_key = ${agentId}`,
          ]);
          return turn?.attached_by && !turn.exec_state && pod?.state === "provisioning"
            ? turn
            : null;
        },
        { timeoutMs: 30_000, intervalMs: 50, label: "turn held while its pod is made" },
      );
      await cluster.kill(0, "SIGKILL");
      await cluster.add();

      // The lease (6 s), the abandoned pod row's stale age (15 s) and a new
      // pod (4 s) — not the five minutes an agent with no turn waits out.
      const t0 = Date.now();
      const { agent, turn } = await waitAgentTurnDone(agentId, "agent");
      expect(Date.now() - t0).toBeLessThan(60_000);
      const ts = await turns(agentId);
      expect(ts.map((t) => t.halt_reason)).toEqual(["error", "natural"]);
      expect(ts[0].id).toBe(held.id);
      expect(agent.total_cost_usd).toBe("0.0123");
      await expectContiguousLogs({ turnId: turn.id }, 5);
    });
  }, 180_000);
});
