import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
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
import { taskQueue } from "../workers/task-worker.js";
import { retrieveSecret } from "./secret-service.js";
import { getGitHubToken } from "./github-token-service.js";
import { syncAllTickets } from "./ticket-sync-service.js";
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
      { id: "p1", source: "github", config: { repoUrl: "https://github.com/o/r" }, enabled: true },
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

  it("skips tickets that already have tasks", async () => {
    mockDbSelect([
      { id: "p1", source: "github", config: { repoUrl: "https://github.com/o/r" }, enabled: true },
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
      { id: "p1", source: "github", config: { repoUrl: "https://github.com/o/r" }, enabled: true },
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
    mockDbSelect([{ id: "p1", source: "github", config: {}, enabled: true }]);

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
      { id: "p1", source: "github", config: { repoUrl: "https://github.com/o/r" }, enabled: true },
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

  it("queries configuredRepos only once even with multiple providers", async () => {
    mockDbSelect(
      [
        {
          id: "p1",
          source: "github",
          config: { repoUrl: "https://github.com/o/r" },
          enabled: true,
        },
        {
          id: "p2",
          source: "jira",
          config: { baseUrl: "https://j.example.com", email: "a@b.com" },
          enabled: true,
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

  it("uses provider config baseUrl for GitLab instead of hardcoded default", async () => {
    mockDbSelect(
      [
        {
          id: "p1",
          source: "gitlab",
          config: { baseUrl: "https://gitlab.corp.example.com" },
          enabled: true,
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
        repoUrl: "https://gitlab.corp.example.com/team/project",
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
      { id: "p1", source: "github", config: { owner: "o", repo: "r" }, enabled: true },
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
});
