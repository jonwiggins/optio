import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const selectRows = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => selectRows() }) }),
  },
}));
vi.mock("./oauth/index.js", () => ({ isAuthDisabled: () => false }));

import { tasks } from "../db/schema.js";
import type { Actor } from "./ownership.js";
import {
  canSeeWork,
  defaultWorkVisibility,
  forgetWorkVisibility,
  getWorkVisibility,
  visibleWork,
  visibleWorkSql,
  workVisibilityOf,
} from "./work-visibility.js";
import { sql } from "drizzle-orm";

const dialect = new PgDialect();
const render = (term: SQL | undefined) => (term ? dialect.sqlToQuery(term) : undefined);

const me = "11111111-1111-1111-1111-111111111111";
const other = "22222222-2222-2222-2222-222222222222";
const myTeam = "33333333-3333-3333-3333-333333333333";
const otherTeam = "44444444-4444-4444-4444-444444444444";

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: me,
  workspaceId: "ws-1",
  isAdmin: false,
  teamIds: [myTeam],
  adminTeamIds: [],
  workVisibility: "teams",
  ...over,
});

afterEach(() => {
  delete process.env.OPTIO_WORK_VISIBILITY_DEFAULT;
  forgetWorkVisibility();
  selectRows.mockReset();
});

describe("the mode", () => {
  it("defaults to organization (upstream's rule) unless the deployment says teams", () => {
    expect(defaultWorkVisibility()).toBe("organization");
    process.env.OPTIO_WORK_VISIBILITY_DEFAULT = "teams";
    expect(defaultWorkVisibility()).toBe("teams");
    process.env.OPTIO_WORK_VISIBILITY_DEFAULT = "nonsense";
    expect(defaultWorkVisibility()).toBe("organization");
  });

  it("takes a workspace's own pick over the deployment's default", () => {
    process.env.OPTIO_WORK_VISIBILITY_DEFAULT = "teams";
    expect(workVisibilityOf({ workVisibility: "organization" })).toBe("organization");
    expect(workVisibilityOf({ workVisibility: null })).toBe("teams");
    expect(workVisibilityOf(undefined)).toBe("teams");
  });

  it("reads a workspace's mode once and remembers it until forgotten", async () => {
    selectRows.mockResolvedValue([{ workVisibility: "teams" }]);
    expect(await getWorkVisibility("ws-1")).toBe("teams");
    expect(await getWorkVisibility("ws-1")).toBe("teams");
    expect(selectRows).toHaveBeenCalledTimes(1);
    forgetWorkVisibility("ws-1");
    selectRows.mockResolvedValue([{ workVisibility: "organization" }]);
    expect(await getWorkVisibility("ws-1")).toBe("organization");
    expect(await getWorkVisibility(null)).toBe("organization");
  });
});

describe("canSeeWork", () => {
  const org = { ownerUserId: null, ownerTeamId: null, createdBy: other };
  const mineOrg = { ownerUserId: null, ownerTeamId: null, createdBy: me };
  const someonesPrivate = { ownerUserId: other, ownerTeamId: null, createdBy: other };
  const myTeams = { ownerUserId: other, ownerTeamId: myTeam, createdBy: other };
  const otherTeams = { ownerUserId: other, ownerTeamId: otherTeam, createdBy: other };
  const myPrivate = { ownerUserId: me, ownerTeamId: null, createdBy: me };

  it("teams mode: own, my teams' and what I created — not the organization's other work", () => {
    const a = actor();
    expect(canSeeWork(myPrivate, a)).toBe(true);
    expect(canSeeWork(myTeams, a)).toBe(true);
    expect(canSeeWork(mineOrg, a)).toBe(true);
    expect(canSeeWork(org, a)).toBe(false);
    expect(canSeeWork(someonesPrivate, a)).toBe(false);
    expect(canSeeWork(otherTeams, a)).toBe(false);
  });

  it("organization mode: the scope rule — the organization's work is everyone's", () => {
    const a = actor({ workVisibility: "organization" });
    expect(canSeeWork(org, a)).toBe(true);
    expect(canSeeWork(myTeams, a)).toBe(true);
    expect(canSeeWork(someonesPrivate, a)).toBe(false);
    expect(canSeeWork(otherTeams, a)).toBe(false);
  });

  it("an actor without a mode is in organization mode", () => {
    expect(canSeeWork(org, actor({ workVisibility: undefined }))).toBe(true);
  });

  it("admins see everything in both modes", () => {
    for (const mode of ["teams", "organization"] as const) {
      const a = actor({ isAdmin: true, workVisibility: mode });
      for (const row of [org, someonesPrivate, otherTeams]) expect(canSeeWork(row, a)).toBe(true);
    }
  });

  it("nobody signed in sees nothing in teams mode", () => {
    expect(canSeeWork(org, actor({ userId: null }))).toBe(false);
  });
});

describe("visibleWork", () => {
  it("is no constraint for an admin", () => {
    expect(
      visibleWork(tasks.ownerUserId, tasks.ownerTeamId, tasks.createdBy, actor({ isAdmin: true })),
    ).toBeUndefined();
  });

  it("teams mode: owner, team and creator — no organization (owner NULL) term", () => {
    const q = render(visibleWork(tasks.ownerUserId, tasks.ownerTeamId, tasks.createdBy, actor()))!;
    expect(q.sql).toContain('"owner_user_id" = $1');
    expect(q.sql).toContain('"owner_team_id" in ($2)');
    expect(q.sql).toContain('"created_by" = $3');
    expect(q.sql).not.toContain("is null");
    expect(q.params).toEqual([me, myTeam, me]);
  });

  it("teams mode without teams or a creator column: own work alone", () => {
    const q = render(
      visibleWork(tasks.ownerUserId, tasks.ownerTeamId, undefined, actor({ teamIds: [] })),
    )!;
    expect(q.sql).toContain('"owner_user_id" = $1');
    expect(q.sql).not.toContain("owner_team_id");
    expect(q.sql).not.toContain("created_by");
  });

  it("organization mode: the scope rule, organization rows included", () => {
    const q = render(
      visibleWork(
        tasks.ownerUserId,
        tasks.ownerTeamId,
        tasks.createdBy,
        actor({ workVisibility: "organization" }),
      ),
    )!;
    expect(q.sql).toContain('"owner_user_id" is null');
    expect(q.sql).not.toContain("created_by");
  });

  it("teams mode with nobody signed in matches nothing", () => {
    const q = render(
      visibleWork(tasks.ownerUserId, tasks.ownerTeamId, tasks.createdBy, actor({ userId: null })),
    )!;
    expect(q.sql).toBe("false");
  });
});

describe("visibleWorkSql", () => {
  const cols = [sql.raw("owner_user_id"), sql.raw("owner_team_id"), sql.raw("created_by")] as const;

  it("is the same rule over columns named in SQL (a UNION's)", () => {
    const q = render(visibleWorkSql(...cols, actor()))!;
    expect(q.sql).toBe("(owner_user_id = $1 or owner_team_id in ($2) or created_by = $3)");
    expect(q.params).toEqual([me, myTeam, me]);
    const org = render(visibleWorkSql(...cols, actor({ workVisibility: "organization" })))!;
    expect(org.sql).toBe("(owner_user_id is null or owner_user_id = $1 or owner_team_id in ($2))");
  });

  it("is no constraint for an admin", () => {
    expect(visibleWorkSql(...cols, actor({ isAdmin: true }))).toBeUndefined();
  });
});
