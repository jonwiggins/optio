import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// db.select(...).from(table).where(...) resolves to whatever `rowsFor(table)` says.
const mockWhere = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({ where: () => mockWhere(table) }),
    }),
  },
}));

import { persistentAgents, prReviews, workRuns } from "../db/schema.js";
import { forgetFrameOwners, frameOwner } from "./frame-owner.js";

const owner = {
  workspaceId: "ws-1",
  ownerUserId: "u-1",
  ownerTeamId: "team-1",
  createdBy: "u-1",
};

describe("frameOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetFrameOwners();
    mockWhere.mockResolvedValue([owner]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a run's owner from the runs table (a Repo Task or a Job run)", async () => {
    expect(await frameOwner({ kind: "run", id: "t-1" })).toEqual(owner);
    expect(mockWhere).toHaveBeenCalledWith(workRuns);
  });

  it("reads an agent's owner from persistent_agents", async () => {
    expect(await frameOwner({ kind: "agent", id: "a-1" })).toEqual(owner);
    expect(mockWhere).toHaveBeenCalledWith(persistentAgents);
  });

  it("makes a PR review the organization's, made by whoever asked for it", async () => {
    mockWhere.mockResolvedValue([{ workspaceId: "ws-1", createdBy: "u-2" }]);
    expect(await frameOwner({ kind: "pr-review", id: "r-1" })).toEqual({
      workspaceId: "ws-1",
      ownerUserId: null,
      ownerTeamId: null,
      createdBy: "u-2",
    });
    expect(mockWhere).toHaveBeenCalledWith(prReviews);
  });

  it("looks a subject up once for every socket that asks within the TTL, even while it runs", async () => {
    let resolve!: (rows: unknown[]) => void;
    mockWhere.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const a = frameOwner({ kind: "run", id: "t-1" });
    const b = frameOwner({ kind: "run", id: "t-1" });
    resolve([owner]);
    expect(await a).toEqual(owner);
    expect(await b).toEqual(owner);
    expect(await frameOwner({ kind: "run", id: "t-1" })).toEqual(owner);
    expect(mockWhere).toHaveBeenCalledTimes(1);
    // Another kind with the same id is another subject.
    await frameOwner({ kind: "agent", id: "t-1" });
    expect(mockWhere).toHaveBeenCalledTimes(2);
  });

  it("looks again once the TTL is over", async () => {
    vi.useFakeTimers();
    await frameOwner({ kind: "run", id: "t-1" });
    vi.advanceTimersByTime(9_000);
    await frameOwner({ kind: "run", id: "t-1" });
    expect(mockWhere).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await frameOwner({ kind: "run", id: "t-1" });
    expect(mockWhere).toHaveBeenCalledTimes(2);
  });

  it("keeps 'not found' only briefly: the row's insert may not have committed yet", async () => {
    vi.useFakeTimers();
    mockWhere.mockResolvedValueOnce([]);
    expect(await frameOwner({ kind: "run", id: "t-new" })).toBeNull();
    expect(await frameOwner({ kind: "run", id: "t-new" })).toBeNull();
    expect(mockWhere).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_500);
    expect(await frameOwner({ kind: "run", id: "t-new" })).toEqual(owner);
    expect(mockWhere).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a failed lookup", async () => {
    mockWhere.mockRejectedValueOnce(new Error("db down"));
    await expect(frameOwner({ kind: "run", id: "t-1" })).rejects.toThrow("db down");
    expect(await frameOwner({ kind: "run", id: "t-1" })).toEqual(owner);
    expect(mockWhere).toHaveBeenCalledTimes(2);
  });

  it("holds at most 5000 subjects, forgetting the oldest", async () => {
    for (let i = 0; i < 5_000; i++) await frameOwner({ kind: "run", id: `t-${i}` });
    expect(mockWhere).toHaveBeenCalledTimes(5_000);
    await frameOwner({ kind: "run", id: "t-5000" });
    // t-0 went to make room; t-1 is still there.
    await frameOwner({ kind: "run", id: "t-1" });
    expect(mockWhere).toHaveBeenCalledTimes(5_001);
    await frameOwner({ kind: "run", id: "t-0" });
    expect(mockWhere).toHaveBeenCalledTimes(5_002);
  });
});
