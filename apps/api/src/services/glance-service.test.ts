import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appleSeconds, TaskState } from "@optio/shared";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockSelectDistinct, tiles } = vi.hoisted(() => ({
  mockSelectDistinct: vi.fn(),
  /** Rows `db.select().from(<table>).where()` resolves per table name. */
  tiles: { rows: new Map<string, unknown[]>(), fail: false },
}));
vi.mock("../db/client.js", () => ({
  db: {
    selectDistinct: (...args: unknown[]) => mockSelectDistinct(...args),
    select: () => ({
      from: (table: { _name: string }) => ({
        where: async () => {
          if (tiles.fail) throw new Error("db down");
          return tiles.rows.get(table._name) ?? [];
        },
      }),
    }),
  },
}));
vi.mock("../db/schema.js", () => {
  const t = (name: string, cols: string[]) =>
    Object.fromEntries([["_name", name], ...cols.map((c) => [c, `${name}.${c}`])]);
  return {
    persistentAgentMessages: {
      turnId: "turn_id",
      senderType: "sender_type",
      senderId: "sender_id",
    },
    workspaceMembers: t("workspace_members", ["workspaceId", "userId"]),
    taskConfigs: t("task_configs", ["enabled", "workspaceId"]),
    workflows: t("workflows", ["enabled", "workspaceId"]),
    localBlueprints: t("local_blueprints", ["enabled", "userId"]),
    persistentAgents: t("persistent_agents", ["state", "workspaceId"]),
    tasks: t("tasks", ["state", "createdBy"]),
  };
});

const { apns, mockShouldNotify, mockListTerminals, mockListHosts } = vi.hoisted(() => {
  type AlertFn = (
    userId: string,
    input: import("./apns-payloads.js").AlertInput,
  ) => Promise<number>;
  type UpdateFn = (
    userId: string,
    state: import("@optio/shared").WatchState,
    opts: { event: "update" | "end"; alert?: { title: string; body: string } | null },
  ) => Promise<void>;
  type StartFn = (
    userId: string,
    state: import("@optio/shared").WatchState,
    opts: { alert?: { title: string; body: string } | null },
  ) => Promise<number>;
  const apns = {
    configured: true,
    isConfigured: vi.fn(() => apns.configured),
    sendAlert: vi.fn<AlertFn>(async () => 1),
    updateWatch: vi.fn<UpdateFn>(async () => {}),
    startWatch: vi.fn<StartFn>(async () => 1),
    hasWatchToken: vi.fn(async () => true),
  };
  return {
    apns,
    mockShouldNotify: vi.fn<(userId: string, eventType: string) => Promise<boolean>>(
      async () => true,
    ),
    mockListTerminals: vi.fn(),
    mockListHosts: vi.fn(),
  };
});
vi.mock("./apns-service.js", () => ({ apnsService: apns }));
vi.mock("./notification-service.js", () => ({
  shouldNotify: (userId: string, eventType: string) => mockShouldNotify(userId, eventType),
}));
vi.mock("./local-terminal-service.js", () => ({
  listTerminals: (...args: unknown[]) => mockListTerminals(...args),
}));
vi.mock("./local-host-service.js", () => ({
  listHosts: (...args: unknown[]) => mockListHosts(...args),
}));

import {
  agentToWatchItem,
  computeWatchState,
  countSessionTiles,
  lastPreviewLine,
  taskToWatchItem,
  onAgentFailed,
  onAgentTurnHalted,
  onLocalHostChanged,
  onLocalTerminalChanged,
  onTaskTransition,
  resetGlanceForTests,
  terminalToWatchItem,
  WATCH_END_GRACE_MS,
} from "./glance-service.js";

const NOW = new Date("2026-09-17T12:00:00Z");

function terminal(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    hostId: "h1",
    userId: "u1",
    workspaceId: null,
    title: "claude-code",
    dir: "/Users/dev/optio/apps/web",
    command: "claude",
    spec: { kind: "agent", agent: "claude-code" },
    state: "running",
    pendingReason: null,
    exitCode: null,
    errorMessage: null,
    attentionState: "working",
    attentionReason: null,
    spawnedBy: "manual",
    blueprintId: null,
    triggerId: null,
    ticketSource: null,
    ticketExternalId: null,
    ticketUrl: null,
    preview: "some output\n\nAllow Bash(rm -rf)?  \n",
    links: [],
    costUsd: null,
    lastActivityAt: null,
    snoozedUntil: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    endedAt: null,
    ...overrides,
  } as never;
}

const host = (overrides: Record<string, unknown> = {}) =>
  ({ id: "h1", userId: "u1", name: "mbp", state: "online", updatedAt: NOW, ...overrides }) as never;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetGlanceForTests();
  vi.clearAllMocks();
  apns.configured = true;
  apns.hasWatchToken.mockResolvedValue(true);
  mockShouldNotify.mockResolvedValue(true);
  mockListHosts.mockResolvedValue([host()]);
  mockListTerminals.mockResolvedValue([]);
  tiles.rows.clear();
  tiles.fail = false;
});
afterEach(() => vi.useRealTimers());

function seedTiles(input: {
  workspaces?: string[];
  taskConfigs?: number;
  workflows?: number;
  localBlueprints?: number;
  agents?: number;
  prOpen?: number;
}) {
  tiles.rows.set(
    "workspace_members",
    (input.workspaces ?? ["ws1"]).map((workspaceId) => ({ workspaceId })),
  );
  tiles.rows.set("task_configs", [{ n: input.taskConfigs ?? 0 }]);
  tiles.rows.set("workflows", [{ n: input.workflows ?? 0 }]);
  tiles.rows.set("local_blueprints", [{ n: input.localBlueprints ?? 0 }]);
  tiles.rows.set("persistent_agents", [{ n: input.agents ?? 0 }]);
  tiles.rows.set("tasks", [{ n: input.prOpen ?? 0 }]);
}

describe("terminalToWatchItem / computeWatchState", () => {
  it("maps a terminal row to a Watch item with reason copy and last preview line", () => {
    const item = terminalToWatchItem(
      terminal({ attentionState: "needs_you", attentionReason: "notification" }),
    );
    expect(item).toEqual({
      kind: "local",
      id: "t1",
      title: "claude-code",
      mono: "web",
      reason: "Waiting on a permission",
      preview: "Allow Bash(rm -rf)?",
      since: appleSeconds(NOW),
      state: "needs_you",
      link: "optio://local/t1?compose=1",
      snoozedUntil: null,
      source: "local-terminal",
      when: "now",
      where: { target: "machine", detail: "~/optio/apps/web" },
      who: "claude-code",
      then: "waits-for-me",
      statusLabel: "needs you",
    });
    expect(lastPreviewLine("a\n\n  \n")).toBe("a");
    expect(lastPreviewLine(null)).toBeNull();
  });

  it("carries the session chips: host in Where, headless agents exit, shells are terminals", () => {
    const headless = terminalToWatchItem(
      terminal({
        spec: { kind: "agent", agent: "codex", mode: "headless" },
        spawnedBy: "job",
        attentionState: "working",
      }),
      { name: "mbp" },
    );
    expect(headless).toMatchObject({
      when: "job",
      where: { target: "machine", detail: "mbp · ~/optio/apps/web" },
      who: "codex",
      then: "exits",
      statusLabel: "working",
    });
    const shell = terminalToWatchItem(
      terminal({ spec: { kind: "shell" }, attentionState: "idle", dir: "/home/dev/x" }),
    );
    expect(shell).toMatchObject({
      who: "terminal",
      then: "waits-for-me",
      statusLabel: "idle",
      where: { target: "machine", detail: "~/x" },
    });
    expect(
      terminalToWatchItem(terminal({ state: "pending", pendingReason: "host_offline" }))
        .statusLabel,
    ).toBe("host offline");
  });

  it("builds task and agent rows with the same four attributes", () => {
    const task = taskToWatchItem({
      id: "task1",
      title: "Fix login",
      state: "pr_opened",
      repoUrl: "https://github.com/acme/web.git",
      repoBranch: "fix/login",
      prUrl: "https://github.com/acme/web/pull/7",
      prNumber: 7,
      agentType: "codex",
      updatedAt: NOW,
      metadata: { taskConfigId: "cfg" },
    });
    expect(task).toMatchObject({
      kind: "task",
      mono: "fix/login",
      reason: "PR #7 open",
      link: "optio://tasks/task1",
      source: "repo-task",
      when: "on a trigger",
      where: { target: "pod", detail: "acme/web" },
      who: "codex",
      then: "exits",
      statusLabel: "PR open",
      since: appleSeconds(NOW),
    });
    expect(
      taskToWatchItem({
        id: "t2",
        title: "Local run",
        state: "needs_attention",
        repoUrl: "https://github.com/acme/web",
        runTarget: "local",
        localDir: "/Users/dev/web",
        errorMessage: "Merge conflict",
        updatedAt: NOW,
      }),
    ).toMatchObject({
      reason: "Merge conflict",
      where: { target: "machine", detail: "~/web" },
      who: "claude-code",
      when: "now",
      statusLabel: "needs attention",
    });

    const agent = agentToWatchItem({
      id: "a1",
      name: "Vesper",
      slug: "vesper",
      state: "failed",
      lastFailureReason: "boom",
      updatedAt: NOW,
    });
    expect(agent).toMatchObject({
      kind: "agent",
      mono: "@vesper",
      reason: "boom",
      link: "optio://agents/a1?compose=1",
      source: "persistent-agent",
      when: "messages",
      where: { target: "pod", detail: "@vesper" },
      who: "claude-code",
      then: "waits-for-messages",
      statusLabel: "failed",
    });
  });

  it("queues running agent terminals needing you (unsnoozed) and counts the rest as running", async () => {
    mockListTerminals.mockResolvedValue([
      terminal({ id: "a", attentionState: "needs_you", attentionReason: "stop" }),
      terminal({
        id: "b",
        attentionState: "needs_you",
        snoozedUntil: new Date(NOW.getTime() + 60_000),
      }),
      terminal({ id: "c", attentionState: "working" }),
      terminal({ id: "d", state: "exited", attentionState: "needs_you" }),
      // A plain shell counts once the daemon has seen an agent in it (attention set)…
      terminal({ id: "e", spec: { kind: "shell" }, attentionState: "needs_you" }),
      terminal({ id: "f", attentionState: "needs_you", snoozedUntil: new Date(NOW.getTime() - 1) }),
      // …but an idle shell with no agent activity never does.
      terminal({ id: "g", spec: { kind: "shell" }, attentionState: "idle" }),
      terminal({ id: "h", spec: { kind: "shell" }, attentionState: null }),
    ]);
    const state = await computeWatchState("u1", NOW);
    expect(state.phase).toBe("waiting");
    expect(state.needsYouCount).toBe(3);
    expect([state.head?.id, ...state.others.map((o) => o.id)].sort()).toEqual(["a", "e", "f"]);
    expect(state.runningCount).toBe(2);
    expect(state.offlineSince).toBeNull();
  });

  it("adds the board tiles: recurring, agents, and waiting (open PRs + idle terminals)", async () => {
    seedTiles({ taskConfigs: 2, workflows: 1, localBlueprints: 3, agents: 4, prOpen: 2 });
    mockListTerminals.mockResolvedValue([
      terminal({ id: "a", attentionState: "idle" }),
      terminal({ id: "b", attentionState: "working" }),
      terminal({ id: "c", spec: { kind: "shell" }, attentionState: "idle" }), // plain shell: not a session
    ]);
    const state = await computeWatchState("u1", NOW);
    expect(state).toMatchObject({
      recurringCount: 6,
      agentCount: 4,
      waitingCount: 3,
      runningCount: 2,
    });
    expect(state.head).toMatchObject({ where: { detail: "mbp · ~/optio/apps/web" } });
  });

  it("counts nothing workspace-scoped for a user without memberships, and survives a DB error", async () => {
    seedTiles({ workspaces: [], localBlueprints: 1, prOpen: 1 });
    expect(await countSessionTiles("u1")).toEqual({ waiting: 1, recurring: 1, agents: 0 });
    tiles.fail = true;
    const state = await computeWatchState("u1", NOW);
    expect(state.recurringCount).toBeNull();
    expect(state.agentCount).toBeNull();
    expect(state.waitingCount).toBeNull();
  });

  it("reports offline when a running terminal's host is unreachable", async () => {
    mockListHosts.mockResolvedValue([host({ state: "offline" })]);
    mockListTerminals.mockResolvedValue([terminal({ attentionState: "working" })]);
    const state = await computeWatchState("u1", NOW);
    expect(state.phase).toBe("offline");
    expect(state.offlineSince).toBe(appleSeconds(NOW));
  });
});

describe("onLocalTerminalChanged", () => {
  it("is a no-op when APNs is unconfigured or the row has no user", async () => {
    apns.configured = false;
    await onLocalTerminalChanged(terminal({ attentionState: "needs_you" }));
    apns.configured = true;
    await onLocalTerminalChanged(terminal({ userId: null, attentionState: "needs_you" }));
    expect(apns.sendAlert).not.toHaveBeenCalled();
    expect(apns.updateWatch).not.toHaveBeenCalled();
  });

  it("alerts with sound on the first needs_you, silently on the next, and never twice for one transition", async () => {
    const first = terminal({
      id: "a",
      attentionState: "needs_you",
      attentionReason: "notification",
    });
    mockListTerminals.mockResolvedValue([first]);
    await onLocalTerminalChanged(first);
    expect(apns.sendAlert).toHaveBeenCalledTimes(1);
    expect(apns.sendAlert.mock.calls[0]).toEqual([
      "u1",
      expect.objectContaining({
        category: "LOCAL_NEEDS_YOU",
        threadId: "a",
        url: "optio://local/a?compose=1",
        sound: "default",
        body: "Waiting on a permission · Allow Bash(rm -rf)?",
      }),
    ]);
    expect(mockShouldNotify).toHaveBeenCalledWith("u1", "local.needs_you");
    // Alerting LA update because the queue was empty before.
    expect(apns.updateWatch).toHaveBeenLastCalledWith(
      "u1",
      expect.objectContaining({ phase: "waiting", needsYouCount: 1 }),
      expect.objectContaining({
        event: "update",
        alert: expect.objectContaining({ title: "Needs you · web" }),
      }),
    );

    // Same row again (e.g. links changed) → no second alert.
    await onLocalTerminalChanged(first);
    expect(apns.sendAlert).toHaveBeenCalledTimes(1);

    const second = terminal({ id: "b", attentionState: "needs_you", attentionReason: "stop" });
    mockListTerminals.mockResolvedValue([first, second]);
    await onLocalTerminalChanged(second);
    expect(apns.sendAlert).toHaveBeenCalledTimes(2);
    expect(apns.sendAlert.mock.calls[1][1]).toMatchObject({ sound: null, threadId: "b" });
    expect(apns.updateWatch).toHaveBeenLastCalledWith(
      "u1",
      expect.objectContaining({ needsYouCount: 2 }),
      { event: "update", alert: null },
    );
  });

  it("respects the user's preference", async () => {
    mockShouldNotify.mockResolvedValue(false);
    const row = terminal({ attentionState: "needs_you", attentionReason: "stop" });
    mockListTerminals.mockResolvedValue([row]);
    await onLocalTerminalChanged(row);
    expect(apns.sendAlert).not.toHaveBeenCalled();
    expect(apns.updateWatch).toHaveBeenCalled(); // the island still refreshes
  });

  it("sends a silent LOCAL_EXIT alert for automated terminal exits", async () => {
    const row = terminal({
      state: "exited",
      exitCode: 0,
      spawnedBy: "ticket",
      attentionState: "needs_you",
      attentionReason: "exit",
    });
    await onLocalTerminalChanged(row);
    expect(apns.sendAlert).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ category: "LOCAL_EXIT", sound: null, url: "optio://local/t1" }),
    );
  });

  it("starts a Watch via push-to-start when the first agent runs and no activity is live", async () => {
    apns.hasWatchToken.mockResolvedValue(false);
    const row = terminal({ attentionState: "working" });
    mockListTerminals.mockResolvedValue([row]);
    await onLocalTerminalChanged(row);
    expect(apns.startWatch).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ phase: "working", runningCount: 1 }),
      { alert: null },
    );
    expect(apns.updateWatch).not.toHaveBeenCalled();

    // Second running terminal: the Watch is (assumed) already started — no new push-to-start.
    const two = terminal({ id: "t2", attentionState: "working" });
    mockListTerminals.mockResolvedValue([row, two]);
    await onLocalTerminalChanged(two);
    expect(apns.startWatch).toHaveBeenCalledTimes(1);
  });

  it("ends the Watch after the quiet grace period, unless something resumes", async () => {
    const row = terminal({ attentionState: "working" });
    mockListTerminals.mockResolvedValue([row]);
    await onLocalTerminalChanged(row);

    const exited = terminal({ state: "exited", attentionState: "idle" });
    mockListTerminals.mockResolvedValue([exited]);
    await onLocalTerminalChanged(exited);
    expect(apns.updateWatch).toHaveBeenCalledTimes(1);

    // Activity resumes inside the grace period → end cancelled.
    mockListTerminals.mockResolvedValue([row]);
    await onLocalTerminalChanged(row);
    await vi.advanceTimersByTimeAsync(WATCH_END_GRACE_MS + 10);
    expect(apns.updateWatch.mock.calls.every((c) => c[2].event === "update")).toBe(true);

    // Goes quiet for good → end frame.
    mockListTerminals.mockResolvedValue([exited]);
    await onLocalTerminalChanged(exited);
    await vi.advanceTimersByTimeAsync(WATCH_END_GRACE_MS + 10);
    expect(apns.updateWatch).toHaveBeenLastCalledWith(
      "u1",
      expect.objectContaining({ phase: "done", summary: "Quiet." }),
      { event: "end" },
    );
  });
});

describe("onLocalHostChanged", () => {
  it("alerts once per outage when agents were running, and refreshes on reconnect", async () => {
    mockListHosts.mockResolvedValue([host({ state: "offline" })]);
    mockListTerminals.mockResolvedValue([terminal({ attentionState: "working" })]);
    await onLocalHostChanged(host({ state: "offline" }));
    await onLocalHostChanged(host({ state: "offline" }));
    expect(apns.sendAlert).toHaveBeenCalledTimes(1);
    expect(apns.sendAlert.mock.calls[0][1]).toMatchObject({ category: "HOST_OFFLINE", id: "h1" });
    expect(mockShouldNotify).toHaveBeenCalledWith("u1", "local.host_offline");
    expect(apns.updateWatch).toHaveBeenLastCalledWith(
      "u1",
      expect.objectContaining({ phase: "offline" }),
      { event: "update", alert: null },
    );

    mockListHosts.mockResolvedValue([host()]);
    await onLocalHostChanged(host({ state: "online" }));
    mockListHosts.mockResolvedValue([host({ state: "offline" })]);
    await onLocalHostChanged(host({ state: "offline" }));
    expect(apns.sendAlert).toHaveBeenCalledTimes(2);
  });

  it("stays silent when nothing was running on the host", async () => {
    mockListHosts.mockResolvedValue([host({ state: "offline" })]);
    await onLocalHostChanged(host({ state: "offline" }));
    expect(apns.sendAlert).not.toHaveBeenCalled();
  });
});

describe("onTaskTransition", () => {
  const task = {
    id: "task-1",
    title: "Fix login",
    repoUrl: "https://github.com/acme/web",
    prUrl: "https://github.com/acme/web/pull/7",
    createdBy: "u1",
  };

  it("alerts TASK_ATTENTION on needs_attention / failed and TASK_PR_OPENED with prUrl", async () => {
    mockListTerminals.mockResolvedValue([terminal({ attentionState: "working" })]);
    await onTaskTransition(task, TaskState.NEEDS_ATTENTION);
    await onTaskTransition({ ...task, errorMessage: "boom" }, TaskState.FAILED);
    await onTaskTransition(task, TaskState.PR_OPENED);
    await onTaskTransition(task, TaskState.RUNNING);
    expect(apns.sendAlert).toHaveBeenCalledTimes(3);
    expect(apns.sendAlert.mock.calls[0][1]).toMatchObject({
      category: "TASK_ATTENTION",
      threadId: "task-task-1",
      url: "optio://tasks/task-1",
      body: "Fix login — acme/web",
    });
    expect(apns.sendAlert.mock.calls[1][1]).toMatchObject({ body: "Fix login — boom" });
    expect(apns.sendAlert.mock.calls[2][1]).toMatchObject({
      category: "TASK_PR_OPENED",
      extra: { prUrl: task.prUrl },
    });
    expect(mockShouldNotify.mock.calls.map((c) => c[1])).toEqual([
      "task.needs_attention",
      "task.failed",
      "task.pr_opened",
    ]);
    // The Watch is refreshed on every transition while a token exists.
    expect(apns.updateWatch).toHaveBeenCalledTimes(4);
  });

  it("skips users without a Watch token for the LA refresh", async () => {
    apns.hasWatchToken.mockResolvedValue(false);
    await onTaskTransition(task, TaskState.COMPLETED);
    expect(apns.updateWatch).not.toHaveBeenCalled();
    expect(apns.sendAlert).not.toHaveBeenCalled();
  });
});

describe("persistent agent hooks", () => {
  const agent = { id: "ag1", name: "Vesper", slug: "vesper", createdBy: "u1" };

  function stubSenders(rows: Array<{ senderId: string | null }>) {
    mockSelectDistinct.mockReturnValue({ from: () => ({ where: async () => rows }) });
  }

  it("replies to each user whose message the turn drained, with the summary as body", async () => {
    stubSenders([{ senderId: "u1" }, { senderId: "u2" }, { senderId: null }]);
    await onAgentTurnHalted(
      {
        id: "turn-1",
        agentId: "ag1",
        haltReason: "natural",
        summary: "  Shipped the healthz PR. ".padEnd(400, "x"),
      },
      agent,
    );
    expect(apns.sendAlert).toHaveBeenCalledTimes(2);
    const input = apns.sendAlert.mock.calls[0][1] as {
      body: string;
      category: string;
      url: string;
      collapseId: string;
    };
    expect(input.category).toBe("AGENT_REPLY");
    expect(input.url).toBe("optio://agents/ag1?compose=1");
    expect(input.body).toHaveLength(200);
    expect(input.collapseId).toBe("agent-ag1-turn-1");
    expect(mockShouldNotify).toHaveBeenCalledWith("u2", "agent.turn_completed");
  });

  it("ignores error halts and turns that drained no user messages", async () => {
    stubSenders([{ senderId: "u1" }]);
    await onAgentTurnHalted({ id: "turn-1", agentId: "ag1", haltReason: "error" }, agent);
    stubSenders([]);
    await onAgentTurnHalted({ id: "turn-2", agentId: "ag1", haltReason: "natural" }, agent);
    expect(apns.sendAlert).not.toHaveBeenCalled();
  });

  it("alerts the creator when the agent fails", async () => {
    await onAgentFailed(agent, "Auth failure: 401");
    expect(apns.sendAlert).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        category: "AGENT_FAILED",
        body: "Too many failed turns — Auth failure: 401",
        url: "optio://agents/ag1",
      }),
    );
    expect(mockShouldNotify).toHaveBeenCalledWith("u1", "agent.failed");
  });
});
