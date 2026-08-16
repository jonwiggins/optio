/**
 * E2E: Persistent Agent turn cycle through the real API server.
 *
 * Covers: POST /api/persistent-agents (creation auto-wakes turn 1 with the
 * initial prompt as a system inbox message) → reconciler idle→queued →
 * enqueueTurn → persistent-agent worker provisions a fake pod, streams claude
 * NDJSON, persists turn logs, drains the inbox, and returns the agent to
 * idle. Then: a user message waking turn 2 on the same sticky pod,
 * [[mock:fail]] failure semantics (consecutive_failures increment + recovery
 * reset), and escalation to `failed` when consecutiveFailureLimit is hit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;

beforeAll(async () => {
  server = await startApiServer();
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

interface AgentRow {
  id: string;
  slug: string;
  state: string;
  podLifecycle: string;
  agentRuntime: string;
  lastTurnAt: string | null;
  sessionId: string | null;
  totalCostUsd: string;
  consecutiveFailures: number;
  consecutiveFailureLimit: number;
  lastFailureReason: string | null;
  lastFailureAt: string | null;
}

interface TurnRow {
  id: string;
  turnNumber: number;
  wakeSource: string;
  wakePayload: { messageIds?: string[]; isFirstTurn?: boolean } | null;
  promptUsed: string | null;
  podId: string | null;
  haltReason: string | null;
  errorMessage: string | null;
  costUsd: string | null;
  sessionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface MessageRow {
  id: string;
  senderType: string;
  body: string;
  receivedAt: string;
  processedAt: string | null;
  turnId: string | null;
}

interface AgentDetail {
  agent: AgentRow;
  inbox: { pending: number; oldest: string | null };
}

async function createAgent(input: Record<string, unknown>): Promise<AgentRow> {
  const { status, body } = await api<{ agent: AgentRow }>("/api/persistent-agents", {
    method: "POST",
    body: JSON.stringify({ agentRuntime: "claude-code", ...input }),
  });
  expect(status).toBe(201);
  return body.agent;
}

async function getAgent(id: string): Promise<AgentDetail> {
  const { status, body } = await api<AgentDetail>(`/api/persistent-agents/${id}`);
  expect(status).toBe(200);
  return body;
}

async function listTurns(id: string): Promise<TurnRow[]> {
  const { body } = await api<{ turns: TurnRow[] }>(`/api/persistent-agents/${id}/turns`);
  return body.turns;
}

async function listMessages(id: string): Promise<MessageRow[]> {
  const { body } = await api<{ messages: MessageRow[] }>(`/api/persistent-agents/${id}/messages`);
  return body.messages;
}

async function sendMessage(id: string, msg: string): Promise<void> {
  const { status } = await api<{ ok: boolean }>(`/api/persistent-agents/${id}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: msg }),
  });
  expect(status).toBe(202);
}

/**
 * Poll until the agent has exactly `turns` finished turns AND has settled in
 * `state` (default "idle"). Both conditions together disambiguate "idle
 * between turns" from "idle after the turn we're waiting on".
 */
async function waitForSettled(
  agentId: string,
  opts: { turns: number; state?: string; timeoutMs?: number },
): Promise<{ agent: AgentRow; inbox: AgentDetail["inbox"]; turns: TurnRow[] }> {
  const wantState = opts.state ?? "idle";
  try {
    return await waitFor(
      async () => {
        const { agent, inbox } = await getAgent(agentId);
        const turns = await listTurns(agentId);
        const settled =
          agent.state === wantState &&
          turns.length === opts.turns &&
          turns.every((t) => t.finishedAt != null);
        return settled ? { agent, inbox, turns } : null;
      },
      {
        timeoutMs: opts.timeoutMs ?? 90_000,
        label: `agent ${agentId} → ${wantState} with ${opts.turns} finished turn(s)`,
      },
    );
  } catch (err) {
    throw new Error(
      `${String(err)}\n--- server logs (tail) ---\n${server.logs().split("\n").slice(-40).join("\n")}`,
    );
  }
}

describe("persistent agent e2e", () => {
  it("runs the first turn on creation and returns to idle with logs and a drained inbox", async () => {
    const initialPrompt = "Report the status of the mock fleet";
    const created = await createAgent({
      slug: "e2e-pa-first",
      name: "First Turn Agent",
      initialPrompt,
    });
    // Defaults: sticky lifecycle, claude-code runtime; the create response is
    // captured before the initial wake so it still reads idle.
    expect(created.podLifecycle).toBe("sticky");
    expect(created.agentRuntime).toBe("claude-code");
    expect(created.state).toBe("idle");

    const { agent, inbox, turns } = await waitForSettled(created.id, { turns: 1 });

    expect(agent.lastTurnAt).not.toBeNull();
    expect(agent.consecutiveFailures).toBe(0);
    expect(agent.sessionId).not.toBeNull();
    // addToTotalCost stores toFixed(6); fake runtime default cost is 0.0123.
    expect(agent.totalCostUsd).toBe("0.012300");
    expect(inbox.pending).toBe(0);

    const [turn] = turns;
    expect(turn.turnNumber).toBe(1);
    // The reconciler enqueues every turn with wakeSource "system"
    // (decideQueued), so even the initial wake records a system turn.
    expect(turn.wakeSource).toBe("system");
    expect(turn.haltReason).toBe("natural");
    expect(turn.errorMessage).toBeNull();
    expect(turn.costUsd).toBe("0.0123");
    expect(turn.sessionId).not.toBeNull();
    expect(turn.wakePayload?.isFirstTurn).toBe(true);
    expect(turn.promptUsed).toContain("# Initial mission");
    expect(turn.promptUsed).toContain(initialPrompt);

    // Turn logs: parsed NDJSON entries from the fake agent stream.
    const { status, body: turnBody } = await api<{
      turn: TurnRow;
      logs: Array<{ content: string; logType: string | null; stream: string }>;
    }>(`/api/persistent-agents/${created.id}/turns/${turn.id}`);
    expect(status).toBe(200);
    expect(turnBody.logs.length).toBeGreaterThan(0);
    const contents = turnBody.logs.map((l) => l.content).join("\n");
    expect(contents).toContain("Mock agent handled");
    expect(turnBody.logs.some((l) => l.logType === "system")).toBe(true);

    // The initial-prompt inbox message was drained into the turn:
    // processedAt stamped and turnId linked (null processedAt = still pending).
    const messages = await listMessages(created.id);
    expect(messages).toHaveLength(1);
    const msg = messages[0];
    expect(msg.senderType).toBe("system");
    expect(msg.body).toBe(initialPrompt);
    expect(msg.processedAt).not.toBeNull();
    expect(msg.turnId).toBe(turn.id);
    expect(turn.wakePayload?.messageIds).toContain(msg.id);
  });

  it("wakes again on a user message and reuses the sticky pod for turn 2", async () => {
    const created = await createAgent({
      slug: "e2e-pa-second",
      name: "Second Turn Agent",
      initialPrompt: "Boot up and wait for instructions",
    });
    await waitForSettled(created.id, { turns: 1 });

    const messageBody = "Summarize the queue please [[mock:cost:0.05]]";
    await sendMessage(created.id, messageBody);

    const { agent, turns } = await waitForSettled(created.id, { turns: 2 });

    // listTurns orders by turnNumber desc.
    const [turn2, turn1] = turns;
    expect(turn1.turnNumber).toBe(1);
    expect(turn2.turnNumber).toBe(2);
    expect(turn2.haltReason).toBe("natural");
    expect(turn2.wakePayload?.isFirstTurn).toBe(false);
    expect(turn2.promptUsed).toContain("# Inbox (1 new message)");
    expect(turn2.promptUsed).toContain(messageBody);
    expect(turn2.promptUsed).not.toContain("# Initial mission");
    expect(turn2.costUsd).toBe("0.05");

    // Sticky lifecycle: turn 2 runs on the same pod row as turn 1.
    expect(turn1.podId).not.toBeNull();
    expect(turn2.podId).toBe(turn1.podId);

    expect(agent.state).toBe("idle");
    expect(agent.consecutiveFailures).toBe(0);
    // 0.0123 (turn 1) + 0.05 (turn 2), stored toFixed(6).
    expect(agent.totalCostUsd).toBe("0.062300");

    const messages = await listMessages(created.id);
    expect(messages).toHaveLength(2);
    const userMsg = messages.find((m) => m.senderType === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg?.processedAt).not.toBeNull();
    expect(userMsg?.turnId).toBe(turn2.id);
  });

  it("records a failed turn on [[mock:fail]] and recovers on the next success", async () => {
    const created = await createAgent({
      slug: "e2e-pa-flaky",
      name: "Flaky Agent",
      initialPrompt: "Boot cleanly",
    });
    await waitForSettled(created.id, { turns: 1 });

    await sendMessage(created.id, "Detonate [[mock:fail]]");
    const afterFail = await waitForSettled(created.id, { turns: 2 });

    const [failedTurn] = afterFail.turns;
    expect(failedTurn.turnNumber).toBe(2);
    expect(failedTurn.haltReason).toBe("error");
    expect(failedTurn.errorMessage).toBe("Mock agent failure");

    // Below consecutiveFailureLimit (default 3) the agent recovers to idle
    // with the failure counted and the reason recorded.
    expect(afterFail.agent.consecutiveFailureLimit).toBe(3);
    expect(afterFail.agent.state).toBe("idle");
    expect(afterFail.agent.consecutiveFailures).toBe(1);
    expect(afterFail.agent.lastFailureReason).toBe("Mock agent failure");
    expect(afterFail.agent.lastFailureAt).not.toBeNull();

    // A successful turn resets the failure counter and clears the reason.
    await sendMessage(created.id, "Back to work");
    const afterRecover = await waitForSettled(created.id, { turns: 3 });
    expect(afterRecover.turns[0].turnNumber).toBe(3);
    expect(afterRecover.turns[0].haltReason).toBe("natural");
    expect(afterRecover.agent.consecutiveFailures).toBe(0);
    expect(afterRecover.agent.lastFailureReason).toBeNull();
  });

  it("escalates to failed when consecutive failures reach the limit", async () => {
    const created = await createAgent({
      slug: "e2e-pa-doomed",
      name: "Doomed Agent",
      initialPrompt: "Melt down immediately [[mock:fail]]",
      consecutiveFailureLimit: 1,
    });

    const { agent, turns } = await waitForSettled(created.id, { turns: 1, state: "failed" });

    expect(turns[0].turnNumber).toBe(1);
    expect(turns[0].haltReason).toBe("error");
    expect(turns[0].errorMessage).toBe("Mock agent failure");
    expect(agent.state).toBe("failed");
    expect(agent.consecutiveFailures).toBe(1);
    expect(agent.lastFailureReason).toBe("Mock agent failure");
    expect(agent.lastFailureAt).not.toBeNull();
  });
});
