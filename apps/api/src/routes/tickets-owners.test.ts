import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Team-owned ticket providers (routes/tickets.ts): who may add, list,
 * change and remove the organization's, a team's and a person's.
 */

const TEAM = "33333333-3333-3333-3333-333333333333";
const OTHER_TEAM = "44444444-4444-4444-4444-444444444444";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  deleted: 0,
  wheres: [] as unknown[],
}));

vi.mock("../db/client.js", () => {
  const selectChain = () => {
    const q: any = {
      from: () => q,
      where: (w: unknown) => {
        state.wheres.push(w);
        return q;
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(state.rows).then(res, rej),
    };
    return q;
  };
  return {
    db: {
      select: () => selectChain(),
      selectDistinct: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            const row = { id: "p-new", ...v };
            state.inserted.push(row);
            return [row];
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          state.deleted++;
        },
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => state.rows }) }),
      }),
    },
  };
});
vi.mock("../services/event-bus.js", () => ({ getRedisClient: () => ({}), publishEvent: vi.fn() }));
vi.mock("../services/inbound-delivery-service.js", () => ({ claimInboundDelivery: vi.fn() }));
vi.mock("../services/ticket-sync-service.js", () => ({
  syncAllTickets: vi.fn(),
  resolveProviderConfig: vi.fn(async (r: { config: object }) => r.config),
}));
vi.mock("../services/secret-service.js", () => ({
  storeSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));
vi.mock("../services/ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/ownership.js")>()),
  // Names are decoration here.
  withOwnerNames: async (rows: unknown[]) => rows,
}));
const isKnownGitLabHost = vi.hoisted(() => vi.fn(async (host: string) => host === "gitlab.corp"));
vi.mock("../services/git-token-service.js", () => ({ isKnownGitLabHost }));
vi.mock("@optio/ticket-providers", () => ({
  getTicketProvider: () => ({ testConnection: vi.fn(async () => ({ ok: true })) }),
  jiraConfigProblem: () => null,
}));

type User = {
  id: string;
  workspaceId: string;
  workspaceRole: "admin" | "member";
  teamIds?: string[];
  adminTeamIds?: string[];
};

const admin: User = { id: "admin-1", workspaceId: "ws-1", workspaceRole: "admin" };
const teamAdmin: User = {
  id: "lead-1",
  workspaceId: "ws-1",
  workspaceRole: "member",
  teamIds: [TEAM],
  adminTeamIds: [TEAM],
};
const teamMember: User = {
  id: "dev-1",
  workspaceId: "ws-1",
  workspaceRole: "member",
  teamIds: [TEAM],
  adminTeamIds: [],
};
const outsider: User = {
  id: "dev-2",
  workspaceId: "ws-1",
  workspaceRole: "member",
  teamIds: [OTHER_TEAM],
  adminTeamIds: [],
};

let app: FastifyInstance;
async function build(user: User) {
  const { buildRouteTestApp } = await import("../test-utils/build-route-test-app.js");
  const { ticketRoutes } = await import("./tickets.js");
  app = await buildRouteTestApp(ticketRoutes, { user: user as never });
}

const jira = (owner?: string) => ({
  source: "jira",
  config: {
    baseUrl: "https://jira.example.com",
    email: "bot@example.com",
    apiToken: "t",
  },
  ...(owner ? { owner } : {}),
});

beforeEach(() => {
  state.rows = [];
  state.inserted = [];
  state.deleted = 0;
  state.wheres = [];
});
afterEach(async () => {
  await app?.close();
});

describe("POST /api/tickets/providers — owner", () => {
  it("a team admin adds the team's provider", async () => {
    await build(teamAdmin);
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: jira(`team:${TEAM}`),
    });
    expect(res.statusCode).toBe(201);
    expect(state.inserted[0]).toMatchObject({
      workspaceId: "ws-1",
      ownerUserId: "lead-1",
      ownerTeamId: TEAM,
    });
  });

  it("a team member who isn't its admin can't", async () => {
    await build(teamMember);
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: jira(`team:${TEAM}`),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/team's admins/);
    expect(state.inserted).toEqual([]);
  });

  it("someone outside the team can't", async () => {
    await build(outsider);
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: jira(`team:${TEAM}`),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/not a member of that team/);
  });

  it("the organization's needs a workspace admin", async () => {
    await build(teamMember);
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: jira(),
    });
    expect(res.statusCode).toBe(403);

    await app.close();
    await build(admin);
    const ok = await app.inject({ method: "POST", url: "/api/tickets/providers", payload: jira() });
    expect(ok.statusCode).toBe(201);
    expect(state.inserted[0]).toMatchObject({ ownerUserId: null, ownerTeamId: null });
  });

  it("any member adds their own", async () => {
    await build(teamMember);
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: jira("me"),
    });
    expect(res.statusCode).toBe(201);
    expect(state.inserted[0]).toMatchObject({ ownerUserId: "dev-1", ownerTeamId: null });
  });
});

describe("GET /api/tickets/providers — what the caller sees", () => {
  const sql = () => new PgDialect().sqlToQuery(state.wheres[0] as never);

  it("a member: the workspace's (and legacy) rows, by owner — organization, own, teams'", async () => {
    await build(teamMember);
    const res = await app.inject({ method: "GET", url: "/api/tickets/providers" });
    expect(res.statusCode).toBe(200);
    const q = sql();
    expect(q.sql).toContain('"ticket_providers"."workspace_id" is null');
    expect(q.sql).toContain('"ticket_providers"."owner_user_id" is null');
    expect(q.sql).toContain('"ticket_providers"."owner_team_id" in');
    expect(q.params).toEqual(["ws-1", "dev-1", TEAM]);
  });

  it("an admin: every owner in the workspace", async () => {
    await build(admin);
    await app.inject({ method: "GET", url: "/api/tickets/providers" });
    const q = sql();
    expect(q.sql).not.toContain("owner_user_id");
    expect(q.params).toEqual(["ws-1"]);
  });
});

describe("DELETE / re-enable / test — the owner gate", () => {
  const teamRow = {
    id: "p1",
    source: "jira",
    config: {},
    enabled: true,
    workspaceId: "ws-1",
    ownerUserId: "lead-1",
    ownerTeamId: TEAM,
  };

  it("a team admin removes the team's provider", async () => {
    state.rows = [teamRow];
    await build(teamAdmin);
    const res = await app.inject({ method: "DELETE", url: "/api/tickets/providers/p1" });
    expect(res.statusCode).toBe(204);
    expect(state.deleted).toBe(1);
  });

  it("a plain team member can't change or remove it", async () => {
    state.rows = [teamRow];
    await build(teamMember);
    for (const [method, url] of [
      ["DELETE", "/api/tickets/providers/p1"],
      ["PATCH", "/api/tickets/providers/p1/re-enable"],
      ["POST", "/api/tickets/providers/p1/test"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(state.deleted).toBe(0);
  });

  it("a workspace admin may remove a team's provider (offboarding) but not edit it", async () => {
    state.rows = [teamRow];
    await build(admin);
    expect(
      (await app.inject({ method: "PATCH", url: "/api/tickets/providers/p1/re-enable" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/tickets/providers/p1" })).statusCode,
    ).toBe(204);
  });

  it("a team admin tests and re-enables it", async () => {
    state.rows = [teamRow];
    await build(teamAdmin);
    expect(
      (await app.inject({ method: "POST", url: "/api/tickets/providers/p1/test" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "PATCH", url: "/api/tickets/providers/p1/re-enable" }))
        .statusCode,
    ).toBe(200);
  });

  it("a provider the caller can't see is a 404", async () => {
    state.rows = [];
    await build(outsider);
    const res = await app.inject({ method: "DELETE", url: "/api/tickets/providers/p1" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tickets/providers — a GitLab provider without a token", () => {
  const gitlab = (host: string, token?: string) => ({
    source: "gitlab",
    config: { host, projectPath: "g/p", ...(token ? { token } : {}) },
    owner: "me",
  });

  it("is refused on a host this deployment doesn't use: it would borrow a GITLAB_TOKEN", async () => {
    await build(teamMember);
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: gitlab("evil.example"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Give the provider a token: evil.example/);
    expect(isKnownGitLabHost).toHaveBeenCalledWith("evil.example", "ws-1");
    expect(state.inserted).toEqual([]);
  });

  it("is added on a GitLab this deployment uses, and any host is fine with a token", async () => {
    await build(teamMember);
    const known = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: gitlab("gitlab.corp"),
    });
    expect(known.statusCode).toBe(201);
    isKnownGitLabHost.mockClear();
    const own = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: gitlab("gitlab.example.org", "glpat-own"),
    });
    expect(own.statusCode).toBe(201);
    expect(isKnownGitLabHost).not.toHaveBeenCalled();
  });
});
