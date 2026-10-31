import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * Owned ticket providers (routes/tickets.ts): who may add, list, change and
 * remove the deployment's, a workspace's, a team's and a person's.
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
const deploymentAdmins = vi.hoisted(() => new Set<string>());
vi.mock("../services/sign-in-config-service.js", () => ({
  isDeploymentAdmin: async (user: { id: string }) => deploymentAdmins.has(user.id),
  hasDeploymentAdmin: async () => true,
  isFoundingWorkspaceAdmin: async () => false,
}));
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
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { ticketRoutes } from "./tickets.js";
async function build(user: User) {
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
  deploymentAdmins.clear();
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
    expect(state.inserted[0]).toMatchObject({
      workspaceId: "ws-1",
      ownerUserId: null,
      ownerTeamId: null,
    });
  });

  it("a deployment admin's organization provider stays the deployment's, as before", async () => {
    deploymentAdmins.add(admin.id);
    await build(admin);
    const ok = await app.inject({ method: "POST", url: "/api/tickets/providers", payload: jira() });
    expect(ok.statusCode).toBe(201);
    expect(state.inserted[0]).toMatchObject({ workspaceId: null, ownerUserId: null });
    // And may borrow the deployment's GitHub token, as before.
    const gh = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: { source: "github", config: { owner: "acme", repo: "app" } },
    });
    expect(gh.statusCode).toBe(201);
    // Their own provider is theirs, in their workspace.
    const mine = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: jira("me"),
    });
    expect(state.inserted[2]).toMatchObject({ workspaceId: "ws-1", ownerUserId: "admin-1" });
    expect(mine.statusCode).toBe(201);
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

describe("the deployment's providers (no workspace)", () => {
  const legacyRow = {
    id: "p0",
    source: "jira",
    config: {},
    enabled: true,
    workspaceId: null,
    ownerUserId: null,
    ownerTeamId: null,
  };

  it("a workspace admin who isn't a deployment admin can't change, test or remove one", async () => {
    // Anyone may make a workspace and be its admin: that never reaches the deployment's.
    state.rows = [legacyRow];
    await build(admin);
    for (const [method, url] of [
      ["DELETE", "/api/tickets/providers/p0"],
      ["PATCH", "/api/tickets/providers/p0/re-enable"],
      ["POST", "/api/tickets/providers/p0/test"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toMatch(/deployment admin/);
    }
    expect(state.deleted).toBe(0);
  });

  it("a deployment admin can", async () => {
    state.rows = [legacyRow];
    deploymentAdmins.add(admin.id);
    await build(admin);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/tickets/providers/p0" })).statusCode,
    ).toBe(204);
  });

  it("without a workspace a new provider is the deployment's: a deployment admin's alone", async () => {
    const noWorkspace = { ...admin, workspaceId: null as unknown as string };
    await build(noWorkspace);
    const refused = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: jira(),
    });
    expect(refused.statusCode).toBe(403);
    await app.close();
    deploymentAdmins.add(admin.id);
    await build(noWorkspace);
    const ok = await app.inject({ method: "POST", url: "/api/tickets/providers", payload: jira() });
    expect(ok.statusCode).toBe(201);
    expect(state.inserted[0]).toMatchObject({ workspaceId: null, ownerUserId: null });
  });
});

describe("credentials and borrowed tokens", () => {
  it("the list never returns a credential, even one an older row kept in its config", async () => {
    state.rows = [
      {
        id: "p2",
        source: "gitlab",
        config: { host: "gitlab.example.com", projectPath: "g/p", token: "glpat-old" },
        enabled: true,
        workspaceId: "ws-1",
        ownerUserId: null,
        ownerTeamId: null,
      },
    ];
    await build(teamMember);
    const res = await app.inject({ method: "GET", url: "/api/tickets/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers[0].config).toEqual({
      host: "gitlab.example.com",
      projectPath: "g/p",
    });
    expect(res.body).not.toContain("glpat-old");
  });

  it("a GitLab token is kept as a secret, not in the row", async () => {
    const { storeSecret } = await import("../services/secret-service.js");
    await build(teamMember);
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: {
        source: "gitlab",
        config: { host: "gitlab.example.com", projectPath: "g/p", token: "glpat-new" },
        owner: "me",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(state.inserted[0].config).toEqual({ host: "gitlab.example.com", projectPath: "g/p" });
    expect(res.body).not.toContain("glpat-new");
    expect(storeSecret).toHaveBeenCalledWith(
      "ticket-provider:p-new",
      JSON.stringify({ token: "glpat-new" }),
      "ticket-provider",
    );
  });

  it("a workspace's GitHub provider brings its own token: the server's is the deployment's", async () => {
    await build(teamMember);
    const res = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: { source: "github", config: { owner: "acme", repo: "app" }, owner: "me" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/GitHub token/);
    expect(state.inserted).toEqual([]);
  });
});

describe("teams off", () => {
  it("a team owner is refused; a person's and the workspace's still work", async () => {
    const noTeams: User = { id: "dev-3", workspaceId: "ws-1", workspaceRole: "member" };
    await build(noTeams);
    const team = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: jira(`team:${TEAM}`),
    });
    expect(team.statusCode).toBe(403);
    expect(team.json().error).toMatch(/Teams are turned off/);
    const mine = await app.inject({
      method: "POST",
      url: "/api/tickets/providers",
      payload: jira("me"),
    });
    expect(mine.statusCode).toBe(201);
    expect(state.inserted[0]).toMatchObject({ ownerUserId: "dev-3", ownerTeamId: null });
  });
});
