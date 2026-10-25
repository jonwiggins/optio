import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

/** Each db.select(...) answers the next queued result; `where` terms are kept for inspection. */
const selects: unknown[][] = [];
const wheres: unknown[] = [];
const inserted: Array<Record<string, unknown>> = [];
let insertConflicts = false;
const updates: Array<Record<string, unknown>> = [];

const chain = () => {
  const result = selects.shift() ?? [];
  const q: any = {
    from: () => q,
    where: (w: unknown) => {
      wheres.push(w);
      return q;
    },
    orderBy: () => q,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  return q;
};

vi.mock("../db/client.js", () => ({
  db: {
    select: () => chain(),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (insertConflicts) return [];
            inserted.push(v);
            return [{ id: `m-${inserted.length}` }];
          },
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          updates.push(v);
        },
      }),
    }),
  },
}));
const syncTeamsFromGroups = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("./team-service.js", () => ({
  syncTeamsFromGroups: (...args: unknown[]) => syncTeamsFromGroups(...args),
}));

import {
  WorkspaceGroupError,
  admitUsersByGroups,
  joinDiscoverableWorkspace,
  joinWorkspacesByGroups,
  listDiscoverableWorkspaces,
  normalizeAccessGroups,
} from "./workspace-groups.js";

beforeEach(() => {
  selects.length = 0;
  wheres.length = 0;
  inserted.length = 0;
  updates.length = 0;
  insertConflicts = false;
  syncTeamsFromGroups.mockClear();
});

describe("normalizeAccessGroups", () => {
  it("lower-cases, trims, drops empties and de-duplicates", () => {
    expect(normalizeAccessGroups(["Eng", " eng ", "", "SRE-Oncall"])).toEqual({
      groups: ["eng", "sre-oncall"],
    });
  });

  it("refuses too many groups and over-long names", () => {
    expect(normalizeAccessGroups(Array.from({ length: 51 }, (_, i) => `g${i}`))).toEqual({
      error: "At most 50 groups",
    });
    expect(normalizeAccessGroups(["x".repeat(300)])).toEqual({
      error: expect.stringContaining("too long"),
    });
  });
});

describe("joinWorkspacesByGroups", () => {
  it("joins every workspace a group opens, with its role (never admin), and fills its teams", async () => {
    selects.push([
      { id: "ws-a", role: "viewer" },
      { id: "ws-b", role: "admin" },
    ]);
    const joined = await joinWorkspacesByGroups("u1", ["ENG", "sre"]);
    expect(joined).toEqual(["ws-a", "ws-b"]);
    // Marked as a group's doing, so the directory sync can take it back.
    expect(inserted).toEqual([
      { workspaceId: "ws-a", userId: "u1", role: "viewer", joinedViaGroups: true },
      { workspaceId: "ws-b", userId: "u1", role: "member", joinedViaGroups: true },
    ]);
    // Compared lower-cased.
    const q = new PgDialect().sqlToQuery(wheres[0] as never);
    expect(q.sql).toContain("lower(g) IN ($1, $2)");
    expect(q.params).toEqual(["eng", "sre"]);
    expect(syncTeamsFromGroups).toHaveBeenCalledWith("u1", "ws-a", ["ENG", "sre"]);
    // The first one joined becomes a first-time user's default.
    expect(updates).toEqual([{ defaultWorkspaceId: "ws-a" }]);
  });

  it("keeps an existing membership and still fills the teams", async () => {
    selects.push([{ id: "ws-a", role: "member" }]);
    insertConflicts = true;
    expect(await joinWorkspacesByGroups("u1", ["eng"])).toEqual([]);
    expect(updates).toEqual([]);
    expect(syncTeamsFromGroups).toHaveBeenCalledTimes(1);
  });

  it("does nothing without groups", async () => {
    expect(await joinWorkspacesByGroups("u1", [" "])).toEqual([]);
    expect(wheres).toEqual([]);
  });
});

describe("admitUsersByGroups", () => {
  it("admits the people already signed in with one of the groups", async () => {
    selects.push([
      { id: "u1", groups: ["Eng"] },
      { id: "u2", groups: ["eng", "sre"] },
    ]);
    expect(await admitUsersByGroups("ws-a", ["eng"], "viewer")).toBe(2);
    expect(inserted.map((r) => r.userId)).toEqual(["u1", "u2"]);
    expect(inserted.every((r) => r.role === "viewer" && r.joinedViaGroups === true)).toBe(true);
    expect(syncTeamsFromGroups).toHaveBeenCalledWith("u2", "ws-a", ["eng", "sre"]);
  });
});

describe("discoverable workspaces", () => {
  it("lists what the person's groups open (none without groups)", async () => {
    selects.push([{ groups: [] }]);
    expect(await listDiscoverableWorkspaces("u1")).toEqual([]);

    selects.push([{ groups: ["Eng"] }]);
    selects.push([]); // the memberships subquery (built, not awaited)
    selects.push([{ id: "ws-a", name: "A", slug: "a", description: null, role: "admin" }]);
    expect(await listDiscoverableWorkspaces("u1")).toEqual([
      { id: "ws-a", name: "A", slug: "a", description: null, role: "member" },
    ]);
  });

  it("joins only when the person's own groups open it", async () => {
    selects.push([{ groups: ["eng"] }]); // the person's groups
    selects.push([]); // no workspace matches
    await expect(joinDiscoverableWorkspace("u1", "ws-x")).rejects.toMatchObject({
      status: 403,
    });

    selects.push([{ groups: [] }]);
    await expect(joinDiscoverableWorkspace("u1", "ws-x")).rejects.toBeInstanceOf(
      WorkspaceGroupError,
    );

    selects.push([{ groups: ["eng"] }]);
    selects.push([{ id: "ws-a", role: "viewer" }]);
    selects.push([{ groups: ["eng"] }]);
    expect(await joinDiscoverableWorkspace("u1", "ws-a")).toEqual({ role: "viewer" });
    expect(inserted).toEqual([
      { workspaceId: "ws-a", userId: "u1", role: "viewer", joinedViaGroups: true },
    ]);
  });

  it("says so when already a member", async () => {
    selects.push([{ groups: ["eng"] }]);
    selects.push([{ id: "ws-a", role: "member" }]);
    insertConflicts = true;
    await expect(joinDiscoverableWorkspace("u1", "ws-a")).rejects.toMatchObject({ status: 409 });
  });
});
