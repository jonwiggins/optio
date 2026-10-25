import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAuthenticateWs = vi.fn();
vi.mock("./ws-auth.js", () => ({
  authenticateWs: (...a: unknown[]) => mockAuthenticateWs(...a),
}));

const mockGetRecentEvents = vi.fn();
vi.mock("../services/task-service.js", () => ({
  getRecentEvents: (...a: unknown[]) => mockGetRecentEvents(...a),
}));

const mockWsActor = vi.fn();
const mockWsActorIn = vi.fn();
vi.mock("./ws-actor.js", () => ({
  wsActor: (...a: unknown[]) => mockWsActor(...a),
  wsActorIn: (...a: unknown[]) => mockWsActorIn(...a),
}));

const mockFrameOwner = vi.fn();
vi.mock("./frame-owner.js", () => ({
  frameOwner: (...a: unknown[]) => mockFrameOwner(...a),
}));

let onMessage: ((channel: string, message: string) => void) | null = null;
vi.mock("../services/event-bus.js", () => ({
  createSubscriber: () => ({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    disconnect: vi.fn(),
    on: (_event: string, fn: (channel: string, message: string) => void) => {
      onMessage = fn;
    },
  }),
}));

vi.mock("./ws-limits.js", () => ({
  getClientIp: () => "1.2.3.4",
  trackConnection: () => true,
  releaseConnection: vi.fn(),
  WS_CLOSE_CONNECTION_LIMIT: 4408,
}));

vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => false }));

import type { Actor } from "../services/ownership.js";
import { canSeeFrame, eventsWs } from "./events.js";

const me = "user-me";
const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: me,
  workspaceId: "ws-1",
  isAdmin: false,
  teamIds: ["team-mine"],
  adminTeamIds: [],
  workVisibility: "organization",
  ...over,
});

describe("canSeeFrame", () => {
  it("keeps log lines off the shared channel (each kind has its own socket)", () => {
    for (const type of [
      "task:log",
      "workflow_run:log",
      "pr_review_run:log",
      "persistent_agent:log",
    ]) {
      expect(canSeeFrame({ type }, actor())).toBe(false);
      expect(canSeeFrame({ type }, actor({ isAdmin: true }))).toBe(false);
    }
  });

  it("shows a team's work to its members, not to others", () => {
    const frame = { type: "task:state_changed", ownerUserId: "creator", ownerTeamId: "team-mine" };
    expect(canSeeFrame(frame, actor())).toBe(true);
    expect(canSeeFrame({ ...frame, ownerTeamId: "team-other" }, actor())).toBe(false);
    expect(canSeeFrame({ ...frame, ownerTeamId: "team-other" }, actor({ isAdmin: true }))).toBe(
      true,
    );
  });

  it("shows private work to its owner alone", () => {
    const frame = { type: "task:state_changed", ownerUserId: "someone", ownerTeamId: null };
    expect(canSeeFrame(frame, actor())).toBe(false);
    expect(canSeeFrame({ ...frame, ownerUserId: me }, actor())).toBe(true);
  });

  it('in "teams" mode, shows the organization\'s work to its creator alone', () => {
    const frame = { type: "task:created", ownerUserId: null, ownerTeamId: null, createdBy: "x" };
    expect(canSeeFrame(frame, actor())).toBe(true);
    expect(canSeeFrame(frame, actor({ workVisibility: "teams" }))).toBe(false);
    expect(canSeeFrame({ ...frame, createdBy: me }, actor({ workVisibility: "teams" }))).toBe(true);
  });

  it("passes frames about no one's work, and local nudges only to their user", () => {
    expect(canSeeFrame({ type: "auth:status_changed" }, actor({ workVisibility: "teams" }))).toBe(
      true,
    );
    expect(canSeeFrame({ type: "local:changed", userId: "someone" }, actor())).toBe(false);
    expect(canSeeFrame({ type: "local:changed", userId: me }, actor())).toBe(true);
  });
});

describe("/ws/events", () => {
  function mockSocket() {
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    });
    return socket;
  }

  async function connect() {
    let handler!: (socket: unknown, req: unknown) => Promise<void>;
    await eventsWs({
      get: (_p: string, _o: unknown, h: typeof handler) => {
        handler = h;
      },
    } as never);
    const socket = mockSocket();
    await handler(socket, { headers: {}, ip: "1.2.3.4", params: {} });
    return socket;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    onMessage = null;
    mockAuthenticateWs.mockResolvedValue({ id: me, workspaceId: "ws-1", workspaceRole: null });
    mockWsActor.mockResolvedValue(actor());
    mockGetRecentEvents.mockResolvedValue([]);
    mockFrameOwner.mockReset();
    mockWsActorIn.mockReset();
    mockWsActorIn.mockResolvedValue(null);
  });

  it("replays only the recent events of work the person may see", async () => {
    await connect();
    expect(mockGetRecentEvents).toHaveBeenCalledWith({
      limit: 20,
      workspaceId: "ws-1",
      visibleTo: actor(),
    });
  });

  /** Publish frames, then wait until the last one (which must reach the socket) is out. */
  async function publish(socket: ReturnType<typeof mockSocket>, ...frames: object[]) {
    const done = { type: "auth:status_changed", done: true };
    for (const frame of [...frames, done]) onMessage!("optio:events", JSON.stringify(frame));
    await vi.waitFor(() =>
      expect(socket.send.mock.calls.some(([m]) => JSON.parse(m as string).done)).toBe(true),
    );
    return socket.send.mock.calls
      .map(([m]) => JSON.parse(m as string))
      .filter((f) => !f.done)
      .map((f) => f.taskId ?? f.workflowRunId ?? f.prReviewId ?? f.agentId ?? f.type);
  }

  const ws1 = { workspaceId: "ws-1", createdBy: null };

  it("forwards a team's live frames to its member and drops others' and log lines", async () => {
    const socket = await connect();
    const sent = await publish(
      socket,
      {
        type: "task:state_changed",
        taskId: "t1",
        ...ws1,
        ownerUserId: "c",
        ownerTeamId: "team-mine",
      },
      { type: "task:state_changed", taskId: "t2", ...ws1, ownerUserId: "c", ownerTeamId: "team-x" },
      { type: "task:log", taskId: "t1", content: "secret output" },
      { type: "workflow_run:log", workflowRunId: "r1", content: "secret output" },
      { type: "pr_review_run:log", prReviewId: "p1", runId: "x", content: "secret output" },
      { type: "persistent_agent:log", agentId: "a1", content: "secret output" },
      { type: "auth:status_changed" },
    );
    expect(sent).toEqual(["t1", "auth:status_changed"]);
    // Frames that say whose and where need no lookup; log lines get none either.
    expect(mockFrameOwner).not.toHaveBeenCalled();
  });

  it("looks up whose the work is for a frame that doesn't say, and filters on it", async () => {
    const owners: Record<string, object | null> = {
      "run:t-team": { ...ws1, ownerUserId: "c", ownerTeamId: "team-mine" },
      "run:t-private": { ...ws1, ownerUserId: "someone", ownerTeamId: null },
      "run:r-team": { ...ws1, ownerUserId: "c", ownerTeamId: "team-mine" },
      "pr-review:p-org": { ...ws1, ownerUserId: null, ownerTeamId: null, createdBy: "x" },
      "agent:a-private": { ...ws1, ownerUserId: "someone", ownerTeamId: null },
    };
    mockFrameOwner.mockImplementation(async (s: { kind: string; id: string }) => {
      return owners[`${s.kind}:${s.id}`] ?? null;
    });
    const socket = await connect();
    const sent = await publish(
      socket,
      { type: "task:stalled", taskId: "t-team", lastLogSummary: "Bash $ npm test" },
      { type: "task:stalled", taskId: "t-private", lastLogSummary: "Bash $ cat .env" },
      { type: "task:comment", taskId: "t-private", commentId: "c1" },
      { type: "task:message", taskId: "t-private", content: "hi" },
      { type: "task:pending_reason", taskId: "t-team", data: { pendingReason: null } },
      // A Job run's frame says only `ownerUserId` (its creator): its team is looked up.
      { type: "workflow_run:state_changed", workflowRunId: "r-team", ownerUserId: "c" },
      { type: "pr_review:state_changed", prReviewId: "p-org" },
      { type: "persistent_agent:message", agentId: "a-private", body: "private" },
    );
    expect(sent).toEqual(["t-team", "t-team", "r-team", "p-org"]);
    expect(mockFrameOwner).toHaveBeenCalledWith({ kind: "run", id: "t-team" });
    expect(mockFrameOwner).toHaveBeenCalledWith({ kind: "run", id: "r-team" });
    expect(mockFrameOwner).toHaveBeenCalledWith({ kind: "pr-review", id: "p-org" });
    expect(mockFrameOwner).toHaveBeenCalledWith({ kind: "agent", id: "a-private" });
  });

  it('in "teams" mode, a looked-up organization review reaches its creator alone', async () => {
    mockWsActor.mockResolvedValue(actor({ workVisibility: "teams" }));
    mockFrameOwner.mockResolvedValue({ ...ws1, ownerUserId: null, ownerTeamId: null });
    const socket = await connect();
    const sent = await publish(
      socket,
      { type: "pr_review:stale", prReviewId: "p-1" },
      { type: "task:comment", taskId: "t-org", commentId: "c1" },
    );
    expect(sent).toEqual([]);
  });

  it("filters by workspace: only the user's, each by who they are there", async () => {
    const owners: Record<string, object> = {
      "run:t-elsewhere": {
        workspaceId: "ws-2",
        ownerUserId: null,
        ownerTeamId: null,
        createdBy: null,
      },
      "run:t-admin-there": {
        workspaceId: "ws-3",
        ownerUserId: "someone",
        ownerTeamId: null,
        createdBy: null,
      },
      "run:t-member-there": {
        workspaceId: "ws-4",
        ownerUserId: "someone",
        ownerTeamId: null,
        createdBy: null,
      },
      "run:t-nowhere": { workspaceId: null, ownerUserId: null, ownerTeamId: null, createdBy: null },
    };
    mockFrameOwner.mockImplementation(async (s: { id: string }) => owners[`run:${s.id}`]);
    mockWsActorIn.mockImplementation(async (_u: unknown, workspaceId: string) =>
      workspaceId === "ws-3"
        ? actor({ workspaceId, isAdmin: true })
        : workspaceId === "ws-4"
          ? actor({ workspaceId })
          : null,
    );
    const socket = await connect();
    const sent = await publish(
      socket,
      { type: "task:stalled", taskId: "t-elsewhere" },
      { type: "task:stalled", taskId: "t-admin-there" },
      { type: "task:stalled", taskId: "t-member-there" },
      { type: "task:stalled", taskId: "t-nowhere" },
      // Says whose and where — another workspace's organization work, not the user's.
      {
        type: "task:state_changed",
        taskId: "t-other-ws",
        workspaceId: "ws-2",
        ownerUserId: null,
        ownerTeamId: null,
        createdBy: null,
      },
      { type: "task:stalled", taskId: "t-admin-there" },
    );
    expect(sent).toEqual(["t-admin-there", "t-admin-there"]);
    // One lookup per workspace for the socket's life, not one per frame.
    expect(mockWsActorIn.mock.calls.map(([, w]) => w).sort()).toEqual(["ws-2", "ws-3", "ws-4"]);
  });

  it("sends a frame whose owner can't be told only to an admin", async () => {
    mockFrameOwner.mockImplementation(async (s: { id: string }) => {
      if (s.id === "t-broken") throw new Error("db down");
      return null;
    });
    const frames = [
      { type: "task:comment", taskId: "t-gone", commentId: "c1" },
      { type: "task:message", taskId: "t-broken", content: "hi" },
    ];
    const member = await connect();
    expect(await publish(member, ...frames)).toEqual([]);

    mockWsActor.mockResolvedValue(actor({ isAdmin: true }));
    const admin = await connect();
    expect(await publish(admin, ...frames)).toEqual(["t-gone", "t-broken"]);
  });

  it("keeps the order frames came in while one waits on a lookup", async () => {
    let release!: (owner: object) => void;
    mockFrameOwner.mockReturnValueOnce(new Promise((r) => (release = r)));
    const socket = await connect();
    onMessage!("optio:events", JSON.stringify({ type: "task:stalled", taskId: "slow" }));
    onMessage!("optio:events", JSON.stringify({ type: "session:ended", sessionId: "s" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(socket.send).not.toHaveBeenCalled();
    release({ ...ws1, ownerUserId: me, ownerTeamId: null });
    const sent = await publish(socket);
    expect(sent).toEqual(["slow", "session:ended"]);
  });
});
