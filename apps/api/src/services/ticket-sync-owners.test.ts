import { describe, it, expect, vi, beforeEach } from "vitest";

// The sync claims each ticket in `ticket_sync_claims` before creating its
// task (an insert that returns a row) and records the task id after.
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(async () => [{ ticket_external_id: "claimed" }]),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    delete: vi.fn(() => ({ where: async () => undefined })),
  },
}));

vi.mock("../db/schema.js", () => ({
  ticketSyncClaims: {
    ticketSource: "ticket_sync_claims.ticket_source",
    ticketExternalId: "ticket_sync_claims.ticket_external_id",
    repoUrl: "ticket_sync_claims.repo_url",
    taskId: "ticket_sync_claims.task_id",
  },
  ticketProviders: {
    enabled: "ticket_providers.enabled",
    id: "ticket_providers.id",
    lastError: "ticket_providers.last_error",
    lastErrorAt: "ticket_providers.last_error_at",
    consecutiveFailures: "ticket_providers.consecutive_failures",
  },
  repos: {
    repoUrl: "repos.repoUrl",
  },
}));

vi.mock("@optio/ticket-providers", () => ({
  getTicketProvider: vi.fn(),
}));

vi.mock("./task-service.js", () => ({
  createTask: vi.fn(),
  transitionTask: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: vi.fn(),
  },
}));

vi.mock("./repo-service.js", () => ({
  getRepoByUrl: vi.fn().mockResolvedValue(null),
}));

vi.mock("./secret-service.js", () => ({
  retrieveSecret: vi.fn(),
}));

// The round trip's own queries are its tests' business (ticket-writeback.int.test.ts,
// ticket-follow-ups.int.test.ts); here only its hooks.
vi.mock("./ticket-writeback.js", () => ({ noteTicketSkipped: vi.fn() }));
vi.mock("./ticket-follow-ups.js", () => ({ ticketRoundTripSweep: vi.fn() }));
const getUserRole = vi.hoisted(() => vi.fn());
vi.mock("./workspace-service.js", () => ({ getUserRole }));
const teamMembershipsOf = vi.hoisted(() => vi.fn());
vi.mock("./team-service.js", () => ({ teamMembershipsOf }));
const fireTicketTriggers = vi.hoisted(() => vi.fn());
vi.mock("./trigger-dispatch.js", () => ({ fireTicketTriggers }));

vi.mock("./github-token-service.js", () => ({
  getGitHubToken: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { db } from "../db/client.js";
import { ticketProviders, repos } from "../db/schema.js";

import { getTicketProvider } from "@optio/ticket-providers";
import * as taskService from "./task-service.js";
import { retrieveSecret } from "./secret-service.js";
import { getGitHubToken } from "./github-token-service.js";
import {
  providerOwnerStanding,
  resolveProviderConfig,
  syncAllTickets,
} from "./ticket-sync-service.js";

/**
 * Mock db.select() to handle two query patterns, matching on the .from() argument:
 * - db.select().from(ticketProviders).where(...) — returns providers
 * - db.select({...}).from(repos) — returns configured repos (no .where())
 */
function mockDbSelect(providers: any[], configuredRepos: any[] = []) {
  (db.select as any) = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockImplementation((table: any) => {
      if (table === ticketProviders) {
        return {
          where: vi.fn().mockResolvedValue(providers),
        };
      }
      if (table === repos) {
        return Promise.resolve(configuredRepos);
      }
      return { where: vi.fn().mockResolvedValue([]) };
    }),
  }));
}

/** Mock db.update() — captures the set/where calls for assertions. */
function mockDbUpdate() {
  const updateState = { setCalls: [] as any[], whereCalls: [] as any[] };
  (db.update as any) = vi.fn().mockImplementation(() => ({
    set: vi.fn().mockImplementation((values: any) => {
      updateState.setCalls.push(values);
      return {
        where: vi.fn().mockImplementation((clause: any) => {
          updateState.whereCalls.push(clause);
          return Promise.resolve();
        }),
      };
    }),
  }));
  return updateState;
}

/**
 * Ticket providers with an owner (routes/tickets.ts, docs/ticket-round-trip.md):
 * a workspace's, a team's or a person's provider fills its owner's work on its
 * workspace's repositories only, waits while its owner can't have work, fires
 * no one else's triggers and never borrows the server's GitHub token; the
 * deployment's (no workspace) works as before. And the round trip's hooks.
 */
const ticket = (over: Record<string, unknown> = {}) => ({
  title: "Add /health",
  body: "Please",
  source: "jira",
  externalId: "PLAT-7",
  url: "https://jira.example.com/browse/PLAT-7",
  labels: [],
  repo: "plat/api",
  ...over,
});
const fakeProvider = (t = ticket()) =>
  ({
    fetchActionableTickets: vi.fn().mockResolvedValue([t]),
    fetchTicketComments: vi.fn().mockResolvedValue([]),
    addComment: vi.fn().mockResolvedValue(undefined),
  }) as any;
const provider = (over: Record<string, unknown> = {}) => ({
  id: "p-team",
  source: "jira",
  config: {},
  enabled: true,
  initialSyncAt: new Date("2026-01-01"),
  workspaceId: "ws-1",
  ownerUserId: "lead-1",
  ownerTeamId: "team-1",
  ...over,
});
const REPOS = [
  { repoUrl: "https://gitlab.other.example/plat/api", workspaceId: "ws-2" },
  { repoUrl: "https://gitlab.example.com/plat/api", workspaceId: "ws-1" },
];
const claimSql = () =>
  JSON.stringify(
    (vi.mocked(db.execute).mock.calls[0]![0] as unknown as { queryChunks: unknown[] }).queryChunks,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(retrieveSecret).mockRejectedValue(new Error("Secret not found"));
  vi.mocked(getGitHubToken).mockResolvedValue("server-token");
  vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
  vi.mocked(taskService.createTask).mockResolvedValue({ id: "task-1", maxRetries: 0 } as any);
  getUserRole.mockResolvedValue("member");
  teamMembershipsOf.mockResolvedValue([{ teamId: "team-1", role: "member" }]);
  mockDbUpdate();
});

describe("a provider's owner", () => {
  it("a team's provider creates the team's tasks in its workspace, created by its creator", async () => {
    mockDbSelect([provider()], REPOS);
    vi.mocked(getTicketProvider).mockReturnValue(fakeProvider());

    expect(await syncAllTickets()).toBe(1);
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://gitlab.example.com/plat/api",
        workspaceId: "ws-1",
        ownerUserId: "lead-1",
        ownerTeamId: "team-1",
        createdBy: "lead-1",
        metadata: {
          ticketUrl: "https://jira.example.com/browse/PLAT-7",
          ticketProviderId: "p-team",
        },
      }),
    );
    // Its claim is its own: another owner's provider on the same project gets a task too.
    expect(claimSql()).toContain("jira@p-team");
    // A team's or a person's tickets fire no one else's triggers.
    expect(fireTicketTriggers).not.toHaveBeenCalled();
  });

  it("doesn't skip a ticket another owner already has a task for", async () => {
    mockDbSelect([provider()], REPOS);
    vi.mocked(getTicketProvider).mockReturnValue(fakeProvider());
    vi.mocked(taskService.listTasks).mockResolvedValue([
      {
        ticketSource: "jira",
        ticketExternalId: "PLAT-7",
        repoUrl: "https://gitlab.example.com/plat/api",
        ownerUserId: null,
        ownerTeamId: null,
      },
    ] as any);
    expect(await syncAllTickets()).toBe(1);
  });

  it("a workspace's provider fills the workspace's work and fires its triggers", async () => {
    mockDbSelect([provider({ ownerUserId: null, ownerTeamId: null })], REPOS);
    vi.mocked(getTicketProvider).mockReturnValue(fakeProvider());
    expect(await syncAllTickets()).toBe(1);
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1", ownerUserId: null, ownerTeamId: null }),
    );
    expect(claimSql()).not.toContain("@p-team");
    expect(fireTicketTriggers).toHaveBeenCalledTimes(1);
  });

  it("the deployment's (no workspace) stays as before: any repo, unowned, unscoped claim", async () => {
    mockDbSelect(
      [provider({ workspaceId: null, ownerUserId: null, ownerTeamId: null })],
      [REPOS[0]],
    );
    vi.mocked(getTicketProvider).mockReturnValue(fakeProvider());
    expect(await syncAllTickets()).toBe(1);
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://gitlab.other.example/plat/api",
        ownerUserId: null,
        ownerTeamId: null,
        createdBy: undefined,
      }),
    );
    expect(getUserRole).not.toHaveBeenCalled();
  });
});

describe("a workspace's provider stays in its workspace", () => {
  it("a repo: label matches only the workspace's repos", async () => {
    mockDbSelect([provider()], [REPOS[0]]);
    const p = fakeProvider();
    vi.mocked(getTicketProvider).mockReturnValue(p);
    const { noteTicketSkipped } = await import("./ticket-writeback.js");

    expect(await syncAllTickets()).toBe(0);
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(noteTicketSkipped).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: expect.objectContaining({ externalId: "PLAT-7" }) }),
    );
  });

  it("a full URL or the provider's repoUrl outside the workspace makes no work", async () => {
    for (const [t, config] of [
      [ticket({ repo: "https://github.com/victim/private" }), {}],
      [ticket({ repo: undefined }), { repoUrl: "https://github.com/victim/private" }],
      [ticket({ repo: "victim/private" }), {}],
    ] as const) {
      vi.mocked(taskService.createTask).mockClear();
      mockDbSelect([provider({ config })], REPOS);
      vi.mocked(getTicketProvider).mockReturnValue(fakeProvider(t as any));
      expect(await syncAllTickets()).toBe(0);
      expect(taskService.createTask).not.toHaveBeenCalled();
    }
  });
});

describe("an owner who can't have work now", () => {
  it("a person who left the workspace (or is a viewer): their provider isn't read", async () => {
    for (const role of [null, "viewer"]) {
      getUserRole.mockResolvedValue(role);
      const p = fakeProvider();
      mockDbSelect([provider({ ownerTeamId: null })], REPOS);
      vi.mocked(getTicketProvider).mockReturnValue(p);
      expect(await syncAllTickets()).toBe(0);
      expect(p.fetchActionableTickets).not.toHaveBeenCalled();
    }
    const { ticketRoundTripSweep } = await import("./ticket-follow-ups.js");
    expect(ticketRoundTripSweep).not.toHaveBeenCalled();
  });

  it("a team's provider while teams are off, or once its creator left the team", async () => {
    teamMembershipsOf.mockResolvedValue([]);
    const p = fakeProvider();
    mockDbSelect([provider()], REPOS);
    vi.mocked(getTicketProvider).mockReturnValue(p);
    expect(await syncAllTickets()).toBe(0);
    expect(p.fetchActionableTickets).not.toHaveBeenCalled();
    expect(await providerOwnerStanding(provider())).toMatch(/teams are off/);
  });

  it("the deployment's and a workspace's providers always can", async () => {
    getUserRole.mockResolvedValue(null);
    expect(await providerOwnerStanding(provider({ workspaceId: null }))).toBeNull();
    expect(
      await providerOwnerStanding(provider({ ownerUserId: null, ownerTeamId: null })),
    ).toBeNull();
  });
});

describe("resolveProviderConfig", () => {
  it("lays the stored secret over the row", async () => {
    vi.mocked(retrieveSecret).mockResolvedValue(JSON.stringify({ apiToken: "secret" }));
    expect(
      await resolveProviderConfig({ id: "p", source: "jira", config: { apiToken: "old", a: 1 } }),
    ).toEqual({ apiToken: "secret", a: 1 });
  });

  it("keeps a token an older row kept in plaintext when no secret is stored", async () => {
    expect(
      await resolveProviderConfig({ id: "p", source: "gitlab", config: { token: "glpat-old" } }),
    ).toEqual({ token: "glpat-old" });
  });

  it("only the deployment's GitHub provider borrows the server's token", async () => {
    expect(
      await resolveProviderConfig({ id: "p", source: "github", config: {}, workspaceId: null }),
    ).toEqual({ token: "server-token" });
    expect(
      await resolveProviderConfig({ id: "p", source: "github", config: {}, workspaceId: "ws-1" }),
    ).toEqual({});
    expect(getGitHubToken).toHaveBeenCalledTimes(1);
  });
});

describe("the ticket round trip's hooks", () => {
  const jira = (roundTrip?: Record<string, unknown>) =>
    provider({
      id: "p-jira",
      ownerUserId: null,
      ownerTeamId: null,
      config: { baseUrl: "https://jira.example.test", ...(roundTrip ? { roundTrip } : {}) },
    });

  it("without a round trip set up, the ticket gets the comment it always got", async () => {
    mockDbSelect([jira()], REPOS);
    const p = fakeProvider();
    vi.mocked(getTicketProvider).mockReturnValue(p);
    expect(await syncAllTickets()).toBe(1);
    expect(p.addComment).toHaveBeenCalledWith(
      "PLAT-7",
      expect.stringContaining("is working on this issue"),
      expect.anything(),
    );
  });

  it("with the round trip on, the comment is the round trip's and the sweep runs", async () => {
    const { ticketRoundTripSweep } = await import("./ticket-follow-ups.js");
    mockDbSelect([jira({ enabled: true, comments: true })], REPOS);
    const p = fakeProvider();
    vi.mocked(getTicketProvider).mockReturnValue(p);
    expect(await syncAllTickets()).toBe(1);
    expect(p.addComment).not.toHaveBeenCalled();
    expect(ticketRoundTripSweep).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p-jira" }),
      expect.objectContaining({ baseUrl: "https://jira.example.test" }),
    );
  });

  it("a failing round trip never fails the provider's sweep", async () => {
    const { ticketRoundTripSweep } = await import("./ticket-follow-ups.js");
    vi.mocked(ticketRoundTripSweep).mockRejectedValueOnce(new Error("boom"));
    mockDbSelect([jira({ enabled: true })], REPOS);
    vi.mocked(getTicketProvider).mockReturnValue(fakeProvider());
    const updates = mockDbUpdate();
    expect(await syncAllTickets()).toBe(1);
    expect(
      updates.setCalls.some((c) => "consecutiveFailures" in c && c.consecutiveFailures > 0),
    ).toBe(false);
  });
});
