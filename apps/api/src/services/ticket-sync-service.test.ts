import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  ticketProviders: {
    enabled: "ticket_providers.enabled",
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

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { db } from "../db/client.js";
import { getTicketProvider } from "@optio/ticket-providers";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { syncAllTickets } from "./ticket-sync-service.js";

describe("ticket-sync-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs new tickets and creates tasks", async () => {
    // Provider config from DB
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
            { source: "github", config: { repoUrl: "https://github.com/o/r" }, enabled: true },
          ]),
      }),
    });

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
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
            { source: "github", config: { repoUrl: "https://github.com/o/r" }, enabled: true },
          ]),
      }),
    });

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

    // Existing task matches
    vi.mocked(taskService.listTasks).mockResolvedValue([
      { ticketSource: "github", ticketExternalId: "123" },
    ] as any);

    const count = await syncAllTickets();
    expect(count).toBe(0);
    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  it("uses codex agent type when ticket has codex label", async () => {
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
            { source: "github", config: { repoUrl: "https://github.com/o/r" }, enabled: true },
          ]),
      }),
    });

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
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          {
            source: "github",
            config: { repoUrl: "https://github.com/fallback/repo" },
            enabled: true,
          },
        ]),
      }),
    });

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
      addComment: vi.fn(),
    } as any);

    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "t-1", maxRetries: 3 } as any);

    await syncAllTickets();

    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://github.com/owner/specific-repo.git",
      }),
    );
  });

  it("skips tickets without repo URL", async () => {
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ source: "github", config: {}, enabled: true }]),
      }),
    });

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
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ source: "github", config: {}, enabled: true }]),
      }),
    });

    vi.mocked(getTicketProvider).mockReturnValue({
      fetchActionableTickets: vi.fn().mockRejectedValue(new Error("API error")),
    } as any);

    const count = await syncAllTickets();
    expect(count).toBe(0);
  });

  it("continues syncing when comment fails", async () => {
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([
            { source: "github", config: { repoUrl: "https://github.com/o/r" }, enabled: true },
          ]),
      }),
    });

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
      addComment: vi.fn().mockRejectedValue(new Error("comment failed")),
    } as any);

    vi.mocked(taskService.listTasks).mockResolvedValue([] as any);
    vi.mocked(taskService.createTask).mockResolvedValue({ id: "t-1", maxRetries: 3 } as any);

    const count = await syncAllTickets();
    expect(count).toBe(1); // Task still synced despite comment failure
  });
});
