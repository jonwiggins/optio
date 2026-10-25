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
  retrieveSecretWithFallback: vi.fn(),
}));

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

const getGitToken = vi.fn();
const isKnownGitLabHost = vi.fn();
vi.mock("./git-token-service.js", () => ({
  getGitToken: (...a: unknown[]) => getGitToken(...a),
  isKnownGitLabHost: (...a: unknown[]) => isKnownGitLabHost(...a),
}));
// The Jira round trip's own queries are its tests' business
// (ticket-writeback.int.test.ts, ticket-follow-ups.int.test.ts); here only its hooks.
vi.mock("./ticket-writeback.js", () => ({ noteTicketSkipped: vi.fn() }));
vi.mock("./ticket-follow-ups.js", () => ({ ticketRoundTripSweep: vi.fn() }));

import { db } from "../db/client.js";
import { ticketProviders, repos } from "../db/schema.js";
import { getTicketProvider } from "@optio/ticket-providers";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { retrieveSecret, retrieveSecretWithFallback } from "./secret-service.js";
import { getGitHubToken } from "./github-token-service.js";
import { getRepoByUrl } from "./repo-service.js";
import { syncAllTickets, resolveProviderConfig, ticketCallConfig } from "./ticket-sync-service.js";
import { logger } from "../logger.js";

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

describe("ticket-sync-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no secrets stored
    vi.mocked(retrieveSecret).mockRejectedValue(new Error("Secret not found"));
    // Default: no GitHub App / PAT available (triggers warn but doesn't throw)
    vi.mocked(getGitHubToken).mockRejectedValue(new Error("No GitHub token available"));
  });

  it("syncs new tickets and creates tasks", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    const mockProvider = {
      fetchActionableTickets: vi.fn().mockResolvedValue([
        {
          title: "Fix bug",
          body: "Description",
          source: "github",
          externalId: "123",
          url: "https://github.com/o/r/issues/123",
          labels: [],
          repo: null,
        },
      ]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getTicketProvider).mockReturnValue(mockProvider as any);

    // No existing tasks
    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);

    vi.mocked(taskService.createTask).mockResolvedValue({
      id: "task-1",
      maxRetries: 3,
    } as any);

    const count = await syncAllTickets();

    expect(count).toBe(1);
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Fix bug",
        repoUrl: "https://github.com/o/r",
        agentType: "claude-code",
        ticketSource: "github",
        ticketExternalId: "123",
      }),
    );
    expect(taskService.transitionTask).toHaveBeenCalledWith("task-1", "queued", "ticket_sync");
    expect(taskQueue.add).toHaveBeenCalled();
    expect(mockProvider.addComment).toHaveBeenCalled();
  });

  it("stamps created tasks with the repo's workspaceId (issue #544)", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    // Repo is configured in a workspace — webhook/poll-created tasks must
    // inherit it or the workspace-scoped UI filters them out.
    vi.mocked(getRepoByUrl).mockResolvedValueOnce({
      id: "repo-1",
      workspaceId: "ws-1",
      defaultAgentType: null,
    } as any);

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([
        {
          title: "Labeled issue",
          body: "Body",
          source: "github",
          externalId: "321",
          url: "https://github.com/o/r/issues/321",
          labels: ["optio"],
          repo: null,
        },
      ]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as any);

    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "task-1", maxRetries: 3 } as any);

    await syncAllTickets();

    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://github.com/o/r",
        workspaceId: "ws-1",
      }),
    );
  });

  describe("a provider's owner (team-owned ticket providers)", () => {
    const ticket = {
      title: "Team ticket",
      body: "Body",
      source: "jira",
      externalId: "PLAT-7",
      url: "https://jira.example.com/browse/PLAT-7",
      labels: [],
      repo: null,
    };
    const teamProvider = {
      id: "p-team",
      source: "jira",
      config: { repoUrl: "https://gitlab.example.com/plat/api" },
      enabled: true,
      initialSyncAt: new Date("2026-01-01"),
      workspaceId: "ws-team",
      ownerUserId: "lead-1",
      ownerTeamId: "team-1",
    };
    const fakeProvider = () =>
      ({
        fetchActionableTickets: vi.fn().mockResolvedValue([ticket]),
        fetchTicketComments: vi.fn().mockResolvedValue([]),
        addComment: vi.fn().mockResolvedValue(undefined),
      }) as any;

    it("creates the owner's tasks in the provider's workspace, created by its owner", async () => {
      mockDbSelect([teamProvider]);
      vi.mocked(getRepoByUrl).mockResolvedValueOnce({ id: "r", workspaceId: "ws-repo" } as any);
      vi.mocked(getTicketProvider).mockReturnValue(fakeProvider());
      vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
      vi.mocked(taskService.createTask).mockResolvedValue({ id: "task-1", maxRetries: 3 } as any);

      await syncAllTickets();

      expect(taskService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-team",
          ownerUserId: "lead-1",
          ownerTeamId: "team-1",
          createdBy: "lead-1",
        }),
      );
      // Its claim is its own: another team's provider on the same project gets a task too.
      const claim = vi.mocked(db.execute).mock.calls[0]![0] as unknown as {
        queryChunks: unknown[];
      };
      expect(JSON.stringify(claim.queryChunks)).toContain("jira@p-team");
    });

    it("a team's provider doesn't skip a ticket another owner already has a task for", async () => {
      mockDbSelect([teamProvider]);
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
      vi.mocked(taskService.createTask).mockResolvedValue({ id: "task-2", maxRetries: 3 } as any);

      expect(await syncAllTickets()).toBe(1);
    });

    it("a legacy provider (no owner) stays the organization's, claimed as before", async () => {
      mockDbSelect([{ ...teamProvider, workspaceId: null, ownerUserId: null, ownerTeamId: null }]);
      vi.mocked(getTicketProvider).mockReturnValue(fakeProvider());
      vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
      vi.mocked(taskService.createTask).mockResolvedValue({ id: "task-3", maxRetries: 3 } as any);

      await syncAllTickets();

      expect(taskService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ ownerUserId: null, ownerTeamId: null, createdBy: undefined }),
      );
      const claim = vi.mocked(db.execute).mock.calls[0]![0] as unknown as {
        queryChunks: unknown[];
      };
      expect(JSON.stringify(claim.queryChunks)).not.toContain("@p-team");
    });
  });

  it("falls back to a NULL workspaceId when the repo is not configured", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    // getRepoByUrl default mock resolves null (unknown repo)
    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([
        {
          title: "Unknown repo issue",
          body: "",
          source: "github",
          externalId: "654",
          url: "",
          labels: [],
          repo: null,
        },
      ]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as any);

    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "task-2", maxRetries: 3 } as any);

    await syncAllTickets();

    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null }),
    );
  });

  it("skips tickets that already have tasks", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([
        {
          title: "Existing",
          body: "",
          source: "github",
          externalId: "123",
          url: "",
          labels: [],
          repo: null,
        },
      ]),
      addComment: vi.fn(),
    } as any);

    // Existing task matches (must include repoUrl for repo-scoped dedup)
    vi.mocked(taskService.listTasks).mockResolvedValue([
      { ticketSource: "github", ticketExternalId: "123", repoUrl: "https://github.com/o/r" },
    ] as any);

    const count = await syncAllTickets();
    expect(count).toBe(0);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  it("uses codex agent type when ticket has codex label", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([
        {
          title: "Codex task",
          body: "",
          source: "github",
          externalId: "456",
          url: "",
          labels: ["codex"],
          repo: null,
        },
      ]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
    } as any);

    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "t-1", maxRetries: 3 } as any);

    await syncAllTickets();

    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: "codex" }),
    );
  });

  it("uses ticket repo URL when available", async () => {
    mockDbSelect(
      [
        {
          id: "p1",
          source: "github",
          config: { repoUrl: "https://github.com/fallback/repo" },
          enabled: true,
          initialSyncAt: new Date("2026-01-01"),
        },
      ],
      [{ repoUrl: "https://github.com/owner/specific-repo" }],
    );

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([
        {
          title: "Task",
          body: "",
          source: "github",
          externalId: "789",
          url: "",
          labels: [],
          repo: "owner/specific-repo",
        },
      ]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
    } as any);

    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "t-1", maxRetries: 3 } as any);

    await syncAllTickets();

    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://github.com/owner/specific-repo",
      }),
    );
  });

  it("skips tickets without repo URL", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: {},
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([
        {
          title: "No repo",
          body: "",
          source: "github",
          externalId: "999",
          url: "",
          labels: [],
          repo: null,
        },
      ]),
      addComment: vi.fn(),
    } as any);

    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);

    const count = await syncAllTickets();
    expect(count).toBe(0);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  it("handles provider errors gracefully", async () => {
    mockDbSelect([
      { id: "p1", source: "github", config: {}, enabled: true, consecutiveFailures: 0 },
    ]);
    mockDbUpdate();

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockRejectedValue(new Error("API error")),
    } as any);

    const count = await syncAllTickets();
    expect(count).toBe(0);
  });

  it("continues syncing when comment fails", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([
        {
          title: "Task",
          body: "",
          source: "github",
          externalId: "111",
          url: "",
          labels: [],
          repo: null,
        },
      ]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockRejectedValue(new Error("comment failed")),
    } as any);

    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "t-1", maxRetries: 3 } as any);

    const count = await syncAllTickets();
    expect(count).toBe(1); // Task still synced despite comment failure
  });

  it("queues the task, and keeps sweeping, when recording it on its claim fails", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);
    (db.update as any) = vi.fn(() => ({
      set: () => ({ where: () => Promise.reject(new Error("connection reset")) }),
    }));
    const ticket = (externalId: string) => ({
      title: `Task ${externalId}`,
      body: "",
      source: "github",
      externalId,
      url: "",
      labels: [],
      repo: null,
    });
    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([ticket("201"), ticket("202")]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockResolvedValue(undefined),
    } as any);
    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask)
      .mockResolvedValueOnce({ id: "t-201", maxRetries: 3 } as any)
      .mockResolvedValueOnce({ id: "t-202", maxRetries: 3 } as any);

    expect(await syncAllTickets()).toBe(2);
    expect(taskService.transitionTask).toHaveBeenCalledWith("t-201", "queued", "ticket_sync");
    expect(taskService.transitionTask).toHaveBeenCalledWith("t-202", "queued", "ticket_sync");
  });

  it("queries configuredRepos only once even with multiple providers", async () => {
    mockDbSelect(
      [
        {
          id: "p1",
          source: "github",
          config: { repoUrl: "https://github.com/o/r" },
          enabled: true,
          initialSyncAt: new Date("2026-01-01"),
        },
        {
          id: "p2",
          source: "jira",
          config: { baseUrl: "https://j.example.com", email: "a@b.com" },
          enabled: true,
          initialSyncAt: new Date("2026-01-01"),
        },
      ],
      [{ repoUrl: "https://github.com/o/r" }],
    );

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([]),
    } as any);

    await syncAllTickets();

    // db.select() should be called exactly twice:
    // 1. providers query (from ticketProviders)
    // 2. configuredRepos query (from repos) — only once, not per provider
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("uses provider config host for GitLab instead of hardcoded default", async () => {
    mockDbSelect(
      [
        {
          id: "p1",
          source: "gitlab",
          // The GitLab schema stores `host` (the provider talks to https://<host>).
          config: { host: "gitlab.example.com.com" },
          enabled: true,
          initialSyncAt: new Date("2026-01-01"),
        },
      ],
      [], // no configured repos — forces URL construction fallback
    );

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([
        {
          title: "GL task",
          body: "",
          source: "gitlab",
          externalId: "42",
          url: "",
          labels: [],
          repo: "team/project",
        },
      ]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
    } as any);

    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "t-1", maxRetries: 3 } as any);

    await syncAllTickets();

    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://gitlab.example.com.com/team/project",
      }),
    );
  });

  it("merges encrypted credentials from secrets store into provider config", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "jira",
        config: { baseUrl: "https://j.example.com", email: "a@b.com", label: "optio" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    // Secret contains the sensitive credentials
    vi.mocked(retrieveSecret).mockResolvedValue(JSON.stringify({ apiToken: "secret-token" }));

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([]),
    } as any);

    await syncAllTickets();

    // The provider should receive the merged config with credentials
    const provider = vi.mocked(getTicketProvider).mock.results[0].value;
    const configPassedToProvider = provider.fetchActionableTickets.mock.calls[0][0];
    expect(configPassedToProvider.apiToken).toBe("secret-token");
    expect(configPassedToProvider.baseUrl).toBe("https://j.example.com");

    // Secret should be retrieved with the provider ID
    expect(retrieveSecret).toHaveBeenCalledWith("ticket-provider:p1", "ticket-provider");
  });

  it("persists last_error and increments consecutive_failures on provider error", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
        consecutiveFailures: 0,
      },
    ]);
    const updateState = mockDbUpdate();

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockRejectedValue(new Error("Bad credentials")),
    } as any);

    await syncAllTickets();

    // Should have called db.update to persist the error
    expect(db.update).toHaveBeenCalled();
    expect(updateState.setCalls[0]).toEqual(
      expect.objectContaining({
        lastError: "Bad credentials",
        consecutiveFailures: 1,
      }),
    );
  });

  it("clears error fields on successful provider sync", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
        consecutiveFailures: 3,
        lastError: "Bad credentials",
        lastErrorAt: new Date(),
      },
    ]);
    const updateState = mockDbUpdate();

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([]),
    } as any);

    await syncAllTickets();

    // Should reset error fields on success
    expect(db.update).toHaveBeenCalled();
    expect(updateState.setCalls[0]).toEqual(
      expect.objectContaining({
        lastError: null,
        lastErrorAt: null,
        consecutiveFailures: 0,
      }),
    );
  });

  it("auto-disables provider after 5 consecutive failures", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
        consecutiveFailures: 4, // one more will hit 5
      },
    ]);
    const updateState = mockDbUpdate();

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockRejectedValue(new Error("Bad credentials")),
    } as any);

    await syncAllTickets();

    // Should have disabled the provider (enabled: false) on the 5th failure
    expect(db.update).toHaveBeenCalled();
    expect(updateState.setCalls[0]).toEqual(
      expect.objectContaining({
        consecutiveFailures: 5,
        enabled: false,
      }),
    );
  });

  it("falls back to getGitHubToken for GitHub providers without a configured token", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { owner: "o", repo: "r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    vi.mocked(getGitHubToken).mockResolvedValue("ghs_app_installation_token");

    const mockProvider = {
      fetchActionableTickets: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(getTicketProvider).mockReturnValue(mockProvider as any);

    await syncAllTickets();

    expect(getGitHubToken).toHaveBeenCalledWith({ server: true });
    const configPassedToProvider = mockProvider.fetchActionableTickets.mock.calls[0][0];
    expect(configPassedToProvider.token).toBe("ghs_app_installation_token");
  });

  it("does not call getGitHubToken when a token is already supplied via config", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { owner: "o", repo: "r", token: "inline-token" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([]),
    } as any);

    await syncAllTickets();

    expect(getGitHubToken).not.toHaveBeenCalled();
  });

  it("does not call getGitHubToken when a token is supplied via provider secret", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { owner: "o", repo: "r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);
    vi.mocked(retrieveSecret).mockResolvedValue(JSON.stringify({ token: "secret-token" }));

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([]),
    } as any);

    await syncAllTickets();

    expect(getGitHubToken).not.toHaveBeenCalled();
  });

  it("does not call getGitHubToken for non-github providers", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "jira",
        config: { baseUrl: "https://j.example.com", email: "a@b.com" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
      },
    ]);

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([]),
    } as any);

    await syncAllTickets();

    expect(getGitHubToken).not.toHaveBeenCalled();
  });

  it("downgrades repeated sync errors to debug level", async () => {
    mockDbSelect([
      {
        id: "p1",
        source: "github",
        config: { repoUrl: "https://github.com/o/r" },
        enabled: true,
        initialSyncAt: new Date("2026-01-01"),
        consecutiveFailures: 2,
        lastError: "Bad credentials",
      },
    ]);
    mockDbUpdate();

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockRejectedValue(new Error("Bad credentials")),
    } as any);

    await syncAllTickets();

    // Repeated failure with same message — should log at debug, not error
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github" }),
      expect.stringContaining("sync tickets"),
    );
    // Should NOT have logged at error level
    expect(logger.error).not.toHaveBeenCalled();
  });

  describe("initial sync backfill (issue #579)", () => {
    const backfillTicket = {
      title: "Pre-existing ticket",
      body: "was labeled before the provider was configured",
      source: "github",
      externalId: "42",
      url: "https://github.com/o/r/issues/42",
      labels: [],
      repo: null,
    };

    function mockProviderWithTicket() {
      const provider = {
        fetchActionableTickets: vi.fn().mockResolvedValue([backfillTicket]),
        fetchTicketComments: vi.fn().mockResolvedValue([]),
        addComment: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(getTicketProvider).mockReturnValue(provider as any);
      return provider;
    }

    it("first sync creates backfill tasks pending, without queueing or commenting", async () => {
      // initialSyncAt is null → this is the provider's first sweep
      mockDbSelect([
        {
          id: "p1",
          source: "github",
          config: { repoUrl: "https://github.com/o/r" },
          enabled: true,
          initialSyncAt: null,
        },
      ]);
      const updates = mockDbUpdate();
      const provider = mockProviderWithTicket();
      vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
      vi.mocked(taskService.createTask).mockResolvedValue({ id: "t1", maxRetries: 2 } as any);

      const count = await syncAllTickets();

      // The task exists (visible for review) but was never started …
      expect(count).toBe(1);
      expect(taskService.createTask).toHaveBeenCalledTimes(1);
      expect(taskService.transitionTask).not.toHaveBeenCalled();
      expect(taskQueue.add).not.toHaveBeenCalled();
      // … nothing was announced on the ticket …
      expect(provider.addComment).not.toHaveBeenCalled();
      // … and the sweep stamped initial_sync_at so the next sync auto-queues.
      expect(updates.setCalls.some((s) => s.initialSyncAt instanceof Date)).toBe(true);
    });

    it("stamps initial_sync_at even when the first sweep matches nothing", async () => {
      mockDbSelect([
        {
          id: "p1",
          source: "github",
          config: { repoUrl: "https://github.com/o/r" },
          enabled: true,
          initialSyncAt: null,
        },
      ]);
      const updates = mockDbUpdate();
      vi.mocked(getTicketProvider).mockReturnValue({
        fetchActionableTickets: vi.fn().mockResolvedValue([]),
      } as any);

      const count = await syncAllTickets();

      expect(count).toBe(0);
      expect(updates.setCalls.some((s) => s.initialSyncAt instanceof Date)).toBe(true);
    });

    it("does not stamp initial_sync_at when the first sweep fails", async () => {
      mockDbSelect([
        {
          id: "p1",
          source: "github",
          config: { repoUrl: "https://github.com/o/r" },
          enabled: true,
          initialSyncAt: null,
          consecutiveFailures: 0,
        },
      ]);
      const updates = mockDbUpdate();
      vi.mocked(getTicketProvider).mockReturnValue({
        fetchActionableTickets: vi.fn().mockRejectedValue(new Error("API error")),
      } as any);

      await syncAllTickets();

      // The failure bookkeeping ran, but no initialSyncAt stamp — the next
      // successful sync is still treated as the initial backfill sweep.
      expect(updates.setCalls.every((s) => !("initialSyncAt" in s))).toBe(true);
    });

    it("syncs after the initial sweep queue tasks as before", async () => {
      mockDbSelect([
        {
          id: "p1",
          source: "github",
          config: { repoUrl: "https://github.com/o/r" },
          enabled: true,
          initialSyncAt: new Date("2026-01-01"),
        },
      ]);
      mockDbUpdate();
      const provider = mockProviderWithTicket();
      vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
      vi.mocked(taskService.createTask).mockResolvedValue({ id: "t1", maxRetries: 2 } as any);

      const count = await syncAllTickets();

      expect(count).toBe(1);
      expect(taskService.transitionTask).toHaveBeenCalledWith("t1", "queued", "ticket_sync");
      expect(taskQueue.add).toHaveBeenCalledTimes(1);
      expect(provider.addComment).toHaveBeenCalledTimes(1);
    });
  });
});

// `resolveProviderConfig` is what the sync and the connection test both
// call a provider with: the row, with the encrypted credentials laid over it.
describe("a ticket's repo: label", () => {
  const jira = (over: Record<string, unknown> = {}) => ({
    id: "p-jira",
    source: "jira",
    config: {},
    enabled: true,
    initialSyncAt: new Date("2026-01-01"),
    workspaceId: "ws-1",
    ...over,
  });
  const labelled = (repo: string) =>
    ({
      fetchActionableTickets: vi.fn().mockResolvedValue([
        {
          title: "T",
          body: "",
          source: "jira",
          externalId: "PLAT-1",
          url: "",
          labels: [],
          repo,
        },
      ]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
    }) as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(retrieveSecret).mockRejectedValue(new Error("Secret not found"));
    vi.mocked(retrieveSecretWithFallback).mockRejectedValue(new Error("Secret not found"));
    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "t-1", maxRetries: 3 } as any);
    delete process.env.GITLAB_HOSTS;
    vi.unstubAllEnvs();
  });

  it("matches only the provider's own workspace's repos", async () => {
    mockDbSelect(
      [jira()],
      [
        { repoUrl: "https://gitlab.other.example/plat/api", workspaceId: "ws-2" },
        { repoUrl: "https://gitlab.example.com/plat/api", workspaceId: "ws-1" },
      ],
    );
    vi.mocked(getTicketProvider).mockReturnValue(labelled("plat/api"));
    await syncAllTickets();
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: "https://gitlab.example.com/plat/api" }),
    );
  });

  it("a legacy provider without a workspace still matches any configured repo", async () => {
    mockDbSelect(
      [jira({ workspaceId: null })],
      [{ repoUrl: "https://gitlab.other.example/plat/api", workspaceId: "ws-2" }],
    );
    vi.mocked(getTicketProvider).mockReturnValue(labelled("plat/api"));
    await syncAllTickets();
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: "https://gitlab.other.example/plat/api" }),
    );
  });

  it("without GitHub offered, an unmatched label is a path on the organization's GitLab", async () => {
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    mockDbSelect([jira()], [{ repoUrl: "https://gitlab.example.com/x/y", workspaceId: "ws-2" }]);
    vi.mocked(retrieveSecretWithFallback).mockResolvedValue("https://gitlab.example.com/");
    vi.mocked(getTicketProvider).mockReturnValue(labelled("plat/api"));
    await syncAllTickets();
    expect(retrieveSecretWithFallback).toHaveBeenCalledWith("GITLAB_HOST", "global", "ws-1");
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: "https://gitlab.example.com/plat/api" }),
    );
  });

  it("without GitHub offered, takes a self-managed host from GITLAB_HOSTS when no secret names one", async () => {
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    mockDbSelect([jira()], []);
    process.env.GITLAB_HOSTS = "gitlab.com, gitlab.lan";
    vi.mocked(getTicketProvider).mockReturnValue(labelled("plat/api"));
    await syncAllTickets();
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: "https://gitlab.lan/plat/api" }),
    );
  });

  it("without GitHub offered, never guesses github.com: no GitLab host, the ticket is skipped", async () => {
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    mockDbSelect([jira()], []);
    vi.mocked(getTicketProvider).mockReturnValue(labelled("plat/api"));
    await syncAllTickets();
    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "PLAT-1", repo: "plat/api" }),
      expect.stringContaining("no GitLab host"),
    );
  });

  it("by default, keeps upstream's github.com guess", async () => {
    mockDbSelect([jira()], []);
    vi.mocked(getTicketProvider).mockReturnValue(labelled("plat/api"));
    await syncAllTickets();
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: "https://github.com/plat/api" }),
    );
  });
});

describe("resolveProviderConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(retrieveSecret).mockRejectedValue(new Error("Secret not found"));
    vi.mocked(getGitHubToken).mockRejectedValue(new Error("No GitHub token available"));
  });

  it("lays the stored secret over the row", async () => {
    vi.mocked(retrieveSecret).mockResolvedValue(JSON.stringify({ apiToken: "pat-token" }));

    const config = await resolveProviderConfig({
      id: "p1",
      source: "jira",
      config: { baseUrl: "https://jira.example.com/jira", deployment: "server" },
    });

    expect(config).toEqual({
      baseUrl: "https://jira.example.com/jira",
      deployment: "server",
      apiToken: "pat-token",
    });
    expect(retrieveSecret).toHaveBeenCalledWith("ticket-provider:p1", "ticket-provider");
  });

  it("keeps a GitLab token saved in plaintext before tokens were encrypted", async () => {
    const config = await resolveProviderConfig({
      id: "p2",
      source: "gitlab",
      config: { host: "gitlab.example.com", token: "glpat-plain", projectPath: "team/project" },
    });

    expect(config.token).toBe("glpat-plain");
  });

  it("prefers the encrypted GitLab token over a plaintext one", async () => {
    vi.mocked(retrieveSecret).mockResolvedValue(JSON.stringify({ token: "glpat-secret" }));

    const config = await resolveProviderConfig({
      id: "p2",
      source: "gitlab",
      config: { host: "gitlab.example.com", token: "glpat-plain", projectPath: "team/project" },
    });

    expect(config.token).toBe("glpat-secret");
    expect(config.host).toBe("gitlab.example.com");
  });

  it("falls back to the GitHub token service for a GitHub provider without a token", async () => {
    vi.mocked(getGitHubToken).mockResolvedValue("ghs_app-token");

    const config = await resolveProviderConfig({
      id: "p3",
      source: "github",
      config: { owner: "o", repo: "r" },
    });

    expect(config.token).toBe("ghs_app-token");
    expect(getGitHubToken).toHaveBeenCalledWith({ server: true });
  });
});

// The ticket round trip's hooks in the sync (docs/ticket-round-trip.md).
describe("the ticket round trip's hooks", () => {
  const jiraProvider = {
    id: "p-jira",
    source: "jira",
    config: {
      baseUrl: "https://jira.example.test",
      deployment: "server",
      apiToken: "x",
      roundTrip: { enabled: true },
    },
    enabled: true,
    initialSyncAt: new Date("2026-01-01"),
    workspaceId: "ws-1",
    ownerUserId: null,
    ownerTeamId: null,
  };
  const ticket = (over: Record<string, unknown> = {}) => ({
    title: "Add /health",
    body: "Please",
    source: "jira",
    externalId: "PLAT-1",
    url: "https://jira.example.test/browse/PLAT-1",
    labels: ["optio"],
    repo: "platform/hello-service",
    metadata: { reporter: { name: "Ada", email: "ada@example.test" } },
    ...over,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(retrieveSecret).mockRejectedValue(new Error("Secret not found"));
    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "task-j", maxRetries: 0 } as any);
  });

  it("without a round trip set up, the ticket gets the comment every ticket source gets", async () => {
    mockDbSelect(
      [{ ...jiraProvider, config: { ...jiraProvider.config, roundTrip: undefined } }],
      [{ repoUrl: "https://gitlab.example.test/platform/hello-service", workspaceId: "ws-1" }],
    );
    const provider = {
      fetchActionableTickets: vi.fn().mockResolvedValue([ticket()]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
    };
    vi.mocked(getTicketProvider).mockReturnValue(provider as any);
    expect(await syncAllTickets()).toBe(1);
    expect(provider.addComment).toHaveBeenCalledWith(
      "PLAT-1",
      expect.stringContaining("is working on this issue"),
      expect.anything(),
    );
  });

  it("notes the provider and reporter on the task, and leaves the comment to the round trip", async () => {
    const { ticketRoundTripSweep } = await import("./ticket-follow-ups.js");
    mockDbSelect(
      [
        {
          ...jiraProvider,
          config: { ...jiraProvider.config, roundTrip: { enabled: true, comments: true } },
        },
      ],
      [{ repoUrl: "https://gitlab.example.test/platform/hello-service", workspaceId: "ws-1" }],
    );
    const provider = {
      fetchActionableTickets: vi.fn().mockResolvedValue([ticket()]),
      fetchTicketComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
    };
    vi.mocked(getTicketProvider).mockReturnValue(provider as any);

    expect(await syncAllTickets()).toBe(1);
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketSource: "jira",
        ticketExternalId: "PLAT-1",
        metadata: {
          ticketUrl: "https://jira.example.test/browse/PLAT-1",
          ticketProviderId: "p-jira",
          ticketReporter: { name: "Ada", email: "ada@example.test" },
        },
      }),
    );
    // The bare "Task ID" comment is upstream's; with the round trip on, the
    // ticket gets a link from ticket-writeback.ts instead.
    expect(provider.addComment).not.toHaveBeenCalled();
    expect(ticketRoundTripSweep).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p-jira" }),
      expect.objectContaining({ baseUrl: "https://jira.example.test" }),
    );
  });

  it("with the round trip off, any source's ticket gets upstream's comment as before", async () => {
    for (const source of ["jira", "github", "gitlab", "linear", "notion"]) {
      vi.mocked(taskService.createTask).mockClear();
      mockDbSelect(
        [{ ...jiraProvider, id: `p-${source}`, source, config: { token: "x" } }],
        [{ repoUrl: "https://gitlab.example.test/platform/hello-service", workspaceId: "ws-1" }],
      );
      const provider = {
        fetchActionableTickets: vi.fn().mockResolvedValue([ticket({ source })]),
        fetchTicketComments: vi.fn().mockResolvedValue([]),
        addComment: vi.fn(),
      };
      vi.mocked(getTicketProvider).mockReturnValue(provider as any);
      expect(await syncAllTickets()).toBe(1);
      expect(provider.addComment).toHaveBeenCalledWith(
        "PLAT-1",
        expect.stringContaining("is working on this issue"),
        expect.anything(),
      );
    }
  });

  it("tells a ticket no repository matches why it is skipped", async () => {
    const { noteTicketSkipped } = await import("./ticket-writeback.js");
    mockDbSelect([jiraProvider], []);
    vi.mocked(retrieveSecretWithFallback).mockRejectedValue(new Error("none"));
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    vi.stubEnv("GITLAB_HOSTS", "");
    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockResolvedValue([ticket({ repo: "nowhere/repo" })]),
      fetchTicketComments: vi.fn(),
      addComment: vi.fn(),
    } as any);

    expect(await syncAllTickets()).toBe(0);
    expect(noteTicketSkipped).toHaveBeenCalledWith({
      provider: expect.objectContaining({ id: "p-jira" }),
      ticket: expect.objectContaining({ externalId: "PLAT-1" }),
      firstSync: false,
    });
    vi.unstubAllEnvs();
  });
});

describe("GitLab issues without a token of their own", () => {
  beforeEach(() => {
    vi.mocked(retrieveSecret).mockRejectedValue(new Error("Secret not found"));
    getGitToken.mockReset();
    isKnownGitLabHost.mockReset();
    isKnownGitLabHost.mockResolvedValue(true);
  });

  it("never sends a GITLAB_TOKEN to a host this deployment doesn't use", async () => {
    isKnownGitLabHost.mockResolvedValue(false);
    getGitToken.mockResolvedValue("org-token");
    const config = await resolveProviderConfig({
      id: "p0",
      source: "gitlab",
      config: { host: "evil.example", projectPath: "g/p" },
      workspaceId: "ws-1",
      ownerUserId: "u-1",
    });
    expect(isKnownGitLabHost).toHaveBeenCalledWith("evil.example", "ws-1");
    expect(getGitToken).not.toHaveBeenCalled();
    expect(config).not.toHaveProperty("token");
  });

  it("uses only a person's own GITLAB_TOKEN for their provider", async () => {
    getGitToken.mockResolvedValue("user-token");
    await resolveProviderConfig({
      id: "p4",
      source: "gitlab",
      config: { host: "gitlab.corp", projectPath: "g/p" },
      workspaceId: "ws-1",
      ownerUserId: "u-1",
    });
    expect(isKnownGitLabHost).toHaveBeenCalledWith("gitlab.corp", "ws-1");
    expect(getGitToken).toHaveBeenCalledWith("gitlab", {
      host: "gitlab.corp",
      userId: "u-1",
      ownerTeamId: null,
      workspaceId: "ws-1",
      server: false,
      ownOnly: true,
    });
  });

  it("uses the owner team's own GITLAB_TOKEN", async () => {
    getGitToken.mockResolvedValue("team-token");
    const config = await resolveProviderConfig({
      id: "p1",
      source: "gitlab",
      config: { host: "gitlab.corp", groupPath: "platform" },
      workspaceId: "ws-1",
      ownerUserId: "u-1",
      ownerTeamId: "team-1",
    });
    expect(config).toMatchObject({ token: "team-token", groupPath: "platform" });
    expect(getGitToken).toHaveBeenCalledWith("gitlab", {
      host: "gitlab.corp",
      userId: "u-1",
      ownerTeamId: "team-1",
      workspaceId: "ws-1",
      server: false,
      ownOnly: true,
    });
  });

  it("uses the organization's for an organization's provider, and keeps a token it has", async () => {
    getGitToken.mockResolvedValue("org-token");
    expect(
      await resolveProviderConfig({ id: "p2", source: "gitlab", config: { projectPath: "g/p" } }),
    ).toMatchObject({ token: "org-token" });
    expect(isKnownGitLabHost).toHaveBeenLastCalledWith("gitlab.com", null);
    expect(getGitToken).toHaveBeenLastCalledWith("gitlab", {
      host: "gitlab.com",
      userId: undefined,
      ownerTeamId: null,
      workspaceId: null,
      server: true,
      ownOnly: false,
    });
    getGitToken.mockClear();
    expect(
      await resolveProviderConfig({
        id: "p3",
        source: "gitlab",
        config: { projectPath: "g/p", token: "own" },
      }),
    ).toMatchObject({ token: "own" });
    expect(getGitToken).not.toHaveBeenCalled();
  });

  it("sends a group's ticket calls to the ticket's own project", () => {
    expect(
      ticketCallConfig({ source: "gitlab", repo: "platform/tools/app" }, { groupPath: "platform" }),
    ).toEqual({ groupPath: "platform", projectPath: "platform/tools/app" });
    const projectConfig = { projectPath: "g/p" };
    expect(ticketCallConfig({ source: "gitlab", repo: "g/p" }, projectConfig)).toBe(projectConfig);
    expect(ticketCallConfig({ source: "github", repo: "a/b" }, {})).toEqual({});
  });
});
