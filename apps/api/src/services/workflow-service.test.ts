import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  workDefinitions: {
    id: "work_definitions.id",
    kind: "work_definitions.kind",
    workspaceId: "work_definitions.workspace_id",
    createdAt: "work_definitions.created_at",
    enabled: "work_definitions.enabled",
  },
  workflowRuns: {
    id: "workflow_runs.id",
    workflowId: "workflow_runs.workflow_id",
    state: "workflow_runs.state",
    createdAt: "workflow_runs.created_at",
  },
  workflowTriggers: {
    id: "workflow_triggers.id",
    workflowId: "workflow_triggers.workflow_id",
    targetType: "workflow_triggers.target_type",
    targetId: "workflow_triggers.target_id",
    type: "workflow_triggers.type",
    enabled: "workflow_triggers.enabled",
    nextFireAt: "workflow_triggers.next_fire_at",
    createdAt: "workflow_triggers.created_at",
  },
  taskLogs: {
    id: "task_logs.id",
    taskId: "task_logs.task_id",
    logType: "task_logs.log_type",
    timestamp: "task_logs.timestamp",
  },
}));

// Jobs are `standalone` work definitions; their CRUD is work-definition-service's.
vi.mock("./work-definition-service.js", () => ({
  getDefinition: vi.fn(),
  listDefinitions: vi.fn(),
  createDefinition: vi.fn(),
  updateDefinition: vi.fn(),
  deleteDefinition: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { mockPublishWorkflowRunEvent } = vi.hoisted(() => ({
  mockPublishWorkflowRunEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./event-bus.js", () => ({
  publishWorkflowRunEvent: mockPublishWorkflowRunEvent,
}));

import { db } from "../db/client.js";
import * as definitions from "./work-definition-service.js";
import type { WorkDefinition } from "./work-definition-service.js";
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listWorkflowsWithStats,
  getWorkflowWithStats,
  listWorkflowRuns,
  getWorkflowRun,
  createWorkflowRun,
  retryWorkflowRun,
  cancelWorkflowRun,
  getWorkflowRunLogs,
  insertWorkflowRunLog,
  appendWorkflowRunLog,
} from "./workflow-service.js";

/** A Job as its `work_definitions` row. */
function definition(overrides: Partial<WorkDefinition> = {}): WorkDefinition {
  return {
    id: "w-1",
    kind: "standalone",
    name: "Deploy",
    description: null,
    workspaceId: null,
    ownerUserId: null,
    podSecrets: null,
    settings: null,
    createdBy: null,
    enabled: true,
    prompt: "Deploy it",
    promptTemplateId: null,
    runTitle: null,
    paramsSchema: null,
    agentType: "claude-code",
    model: null,
    agentOptions: null,
    repoUrl: null,
    repoBranch: null,
    runTarget: "cluster",
    localHostId: null,
    localDir: null,
    localSessionMode: "headless",
    environmentSpec: null,
    spawnMode: "auto",
    maxRetries: 1,
    priority: 100,
    autoResume: null,
    autoMerge: null,
    maxTurns: null,
    budgetUsd: null,
    maxConcurrent: 2,
    warmPoolSize: 0,
    maxPodInstances: 1,
    maxAgentsPerPod: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("workflow-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(definitions.getDefinition).mockResolvedValue(null);
    vi.mocked(definitions.listDefinitions).mockResolvedValue([]);
  });

  describe("listWorkflows", () => {
    it("lists the standalone definitions as Jobs", async () => {
      vi.mocked(definitions.listDefinitions).mockResolvedValue([
        definition({ id: "w-1", name: "Deploy", prompt: "Deploy {{REPO}}" }),
      ]);

      const result = await listWorkflows();

      expect(definitions.listDefinitions).toHaveBeenCalledWith("standalone", undefined);
      expect(result).toEqual([
        expect.objectContaining({
          id: "w-1",
          name: "Deploy",
          promptTemplate: "Deploy {{REPO}}",
          agentRuntime: "claude-code",
        }),
      ]);
    });

    it("filters by workspaceId when provided", async () => {
      await listWorkflows("ws-1");

      const [kind, where] = vi.mocked(definitions.listDefinitions).mock.calls[0];
      expect(kind).toBe("standalone");
      expect(where).toBeDefined();
    });
  });

  describe("getWorkflow", () => {
    it("returns workflow when found", async () => {
      vi.mocked(definitions.getDefinition).mockResolvedValue(
        definition({ id: "w-1", name: "Deploy", agentType: null, localSessionMode: null }),
      );

      const result = await getWorkflow("w-1");

      expect(definitions.getDefinition).toHaveBeenCalledWith("w-1", "standalone");
      // The legacy shape: no agent is a shell command; no session mode is headless.
      expect(result).toMatchObject({
        id: "w-1",
        name: "Deploy",
        promptTemplate: "Deploy it",
        agentRuntime: "shell",
        localSessionMode: "headless",
      });
    });

    it("returns null when not found", async () => {
      const result = await getWorkflow("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createWorkflow", () => {
    it("creates a workflow with required fields", async () => {
      vi.mocked(definitions.createDefinition).mockImplementation(async (_kind, values) =>
        definition({ id: "w-1", ...values } as Partial<WorkDefinition>),
      );

      const result = await createWorkflow({
        name: "Pipeline",
        promptTemplate: "Do it",
      });

      expect(definitions.createDefinition).toHaveBeenCalledWith(
        "standalone",
        expect.objectContaining({ name: "Pipeline", prompt: "Do it" }),
      );
      expect(result).toMatchObject({ id: "w-1", name: "Pipeline", promptTemplate: "Do it" });
    });

    it("passes all optional fields through", async () => {
      vi.mocked(definitions.createDefinition).mockImplementation(async (_kind, values) =>
        definition({ id: "w-1", ...values } as Partial<WorkDefinition>),
      );

      await createWorkflow({
        name: "Full",
        promptTemplate: "Do it",
        model: "opus",
        maxTurns: 10,
        budgetUsd: "5.00",
        maxConcurrent: 4,
        maxRetries: 3,
        warmPoolSize: 1,
        enabled: false,
      });

      const capturedValues = vi.mocked(definitions.createDefinition).mock.calls[0][1];
      expect(capturedValues.model).toBe("opus");
      expect(capturedValues.maxTurns).toBe(10);
      expect(capturedValues.maxConcurrent).toBe(4);
      expect(capturedValues.enabled).toBe(false);
    });

    it("uses defaults for optional fields", async () => {
      vi.mocked(definitions.createDefinition).mockImplementation(async (_kind, values) =>
        definition({ id: "w-1", ...values } as Partial<WorkDefinition>),
      );

      await createWorkflow({
        name: "Minimal",
        promptTemplate: "Do it",
      });

      const capturedValues = vi.mocked(definitions.createDefinition).mock.calls[0][1];
      expect(capturedValues.agentType).toBe("claude-code");
      expect(capturedValues.maxConcurrent).toBe(2);
      expect(capturedValues.maxRetries).toBe(1);
      expect(capturedValues.warmPoolSize).toBe(0);
      expect(capturedValues.enabled).toBe(true);
    });
  });

  describe("updateWorkflow", () => {
    it("updates workflow fields", async () => {
      vi.mocked(definitions.updateDefinition).mockResolvedValue(
        definition({ id: "w-1", name: "Updated", prompt: "New prompt" }),
      );

      const result = await updateWorkflow("w-1", {
        name: "Updated",
        promptTemplate: "New prompt",
        agentRuntime: "codex",
      });

      // Legacy field names map onto the definition's columns.
      expect(definitions.updateDefinition).toHaveBeenCalledWith("w-1", "standalone", {
        name: "Updated",
        prompt: "New prompt",
        agentType: "codex",
      });
      expect(result).toMatchObject({ id: "w-1", name: "Updated", promptTemplate: "New prompt" });
    });

    it("returns null when workflow not found", async () => {
      vi.mocked(definitions.updateDefinition).mockResolvedValue(null);

      const result = await updateWorkflow("nonexistent", { name: "X" });
      expect(result).toBeNull();
    });
  });

  describe("deleteWorkflow", () => {
    it("returns true when workflow is deleted", async () => {
      vi.mocked(definitions.deleteDefinition).mockResolvedValue(true);

      const result = await deleteWorkflow("w-1");
      expect(definitions.deleteDefinition).toHaveBeenCalledWith("w-1", "standalone");
      expect(result).toBe(true);
    });

    it("returns false when workflow not found", async () => {
      vi.mocked(definitions.deleteDefinition).mockResolvedValue(false);

      const result = await deleteWorkflow("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("listWorkflowsWithStats", () => {
    function mockTriggerQuery(triggers: Array<{ targetId: string; type: string }>) {
      const mockWhere = vi.fn().mockResolvedValue(triggers);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      (db.select as any) = vi.fn().mockReturnValue({ from: mockFrom });
    }

    it("returns workflows with aggregate stats", async () => {
      vi.mocked(definitions.listDefinitions).mockResolvedValue([
        definition({
          id: "w-1",
          name: "Deploy Pipeline",
          description: "Deploy to prod",
          workspaceId: "ws-1",
          prompt: "Deploy {{REPO_NAME}}",
          createdBy: "u-1",
        }),
      ]);
      (db.execute as any) = vi.fn().mockResolvedValue([
        {
          workflow_id: "w-1",
          run_count: "3",
          // Raw SQL hands timestamps back as Postgres text, not ISO.
          last_run_at: "2026-01-15 00:00:00+00",
          total_cost_usd: "4.5000",
          recent_queued: "0",
          recent_running: "1",
          recent_failed: "0",
          recent_completed: "2",
        },
      ]);
      mockTriggerQuery([
        { targetId: "w-1", type: "manual" },
        { targetId: "w-1", type: "schedule" },
        { targetId: "w-1", type: "schedule" },
      ]);

      const result = await listWorkflowsWithStats("ws-1");

      expect(definitions.listDefinitions).toHaveBeenCalledWith("standalone", expect.anything());
      expect(db.execute).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].runCount).toBe(3);
      // Converted to a Date, so it serializes as ISO-8601 like drizzle rows.
      expect(result[0].lastRunAt).toEqual(new Date("2026-01-15T00:00:00Z"));
      expect(result[0].createdAt).toEqual(new Date("2026-01-01T00:00:00Z"));
      expect(result[0].totalCostUsd).toBe("4.5000");
      expect(result[0].recentStats).toEqual({ queued: 0, running: 1, failed: 0, completed: 2 });
      expect(result[0].name).toBe("Deploy Pipeline");
      expect(result[0].promptTemplate).toBe("Deploy {{REPO_NAME}}");
      expect(result[0].triggerTypes).toEqual(["manual", "schedule"]);
    });

    it("returns empty array when no workflows exist", async () => {
      (db.execute as any) = vi.fn().mockResolvedValue([]);

      const result = await listWorkflowsWithStats();

      expect(result).toEqual([]);
      // Nothing to aggregate — no stats query at all.
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("maps zero stats for workflows with no runs", async () => {
      vi.mocked(definitions.listDefinitions).mockResolvedValue([
        definition({ id: "w-2", name: "Empty", prompt: "..." }),
      ]);
      (db.execute as any) = vi.fn().mockResolvedValue([]);
      mockTriggerQuery([]);

      const result = await listWorkflowsWithStats();

      expect(result[0].runCount).toBe(0);
      expect(result[0].lastRunAt).toBeNull();
      expect(result[0].totalCostUsd).toBe("0");
      expect(result[0].recentStats).toEqual({ queued: 0, running: 0, failed: 0, completed: 0 });
      expect(result[0].triggerTypes).toEqual([]);
    });
  });

  describe("getWorkflowWithStats", () => {
    it("returns workflow with stats when found", async () => {
      vi.mocked(definitions.getDefinition).mockResolvedValue(
        definition({ id: "w-1", name: "Deploy" }),
      );

      (db.execute as any) = vi.fn().mockResolvedValue([
        {
          workflow_id: "w-1",
          run_count: "5",
          last_run_at: "2026-01-20 00:00:00+00",
          total_cost_usd: "10.0000",
        },
      ]);

      const result = await getWorkflowWithStats("w-1");

      expect(result).not.toBeNull();
      expect(result!.runCount).toBe(5);
      expect(result!.lastRunAt).toEqual(new Date("2026-01-20T00:00:00Z"));
      expect(result!.totalCostUsd).toBe("10.0000");
      expect(result!.name).toBe("Deploy");
    });

    it("returns null when workflow not found", async () => {
      (db.execute as any) = vi.fn();

      const result = await getWorkflowWithStats("nonexistent");

      expect(result).toBeNull();
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("handles missing stats row gracefully", async () => {
      vi.mocked(definitions.getDefinition).mockResolvedValue(
        definition({ id: "w-1", name: "Test", prompt: "..." }),
      );

      (db.execute as any) = vi.fn().mockResolvedValue([]);

      const result = await getWorkflowWithStats("w-1");

      expect(result).not.toBeNull();
      expect(result!.runCount).toBe(0);
      expect(result!.lastRunAt).toBeNull();
      expect(result!.totalCostUsd).toBe("0");
    });
  });

  describe("listWorkflowRuns", () => {
    it("lists runs for a workflow", async () => {
      const runs = [{ id: "wr-1" }, { id: "wr-2" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(runs),
            }),
          }),
        }),
      });

      const result = await listWorkflowRuns("w-1");
      expect(result).toEqual(runs);
    });
  });

  describe("getWorkflowRun", () => {
    it("returns run when found", async () => {
      const run = { id: "wr-1", state: "running" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([run]),
        }),
      });

      const result = await getWorkflowRun("wr-1");
      expect(result).toEqual(run);
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getWorkflowRun("nonexistent");
      expect(result).toBeNull();
    });
  });

  // ── Workflow Trigger CRUD ───────────────────────────────────────────────────

  describe("createWorkflowRun", () => {
    it("creates a run for an enabled workflow", async () => {
      vi.mocked(definitions.getDefinition).mockResolvedValue(
        definition({ id: "wf-1", enabled: true }),
      );

      const created = { id: "wr-1", workflowId: "wf-1", state: "queued" };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      });

      const result = await createWorkflowRun("wf-1", { params: { key: "value" } });
      expect(result).toEqual(created);
    });

    it("throws when workflow not found", async () => {
      await expect(createWorkflowRun("nonexistent")).rejects.toThrow("Workflow not found");
    });

    it("throws when workflow is disabled", async () => {
      vi.mocked(definitions.getDefinition).mockResolvedValue(
        definition({ id: "wf-1", enabled: false }),
      );

      await expect(createWorkflowRun("wf-1")).rejects.toThrow("Workflow is disabled");
    });
  });

  describe("retryWorkflowRun", () => {
    it("retries a failed workflow run", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wr-1", state: "failed", retryCount: 0 }]),
        }),
      });

      const updated = { id: "wr-1", state: "queued", retryCount: 1 };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await retryWorkflowRun("wr-1");
      expect(result).toEqual(updated);
    });

    it("throws when run is not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(retryWorkflowRun("nonexistent")).rejects.toThrow("Workflow run not found");
    });

    it("throws when run is still running", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wr-1", state: "running", retryCount: 0 }]),
        }),
      });

      await expect(retryWorkflowRun("wr-1")).rejects.toThrow(/Cannot retry/);
    });

    it("throws when run is completed (terminal)", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wr-1", state: "completed", retryCount: 0 }]),
        }),
      });

      await expect(retryWorkflowRun("wr-1")).rejects.toThrow(/Cannot retry/);
    });
  });

  describe("cancelWorkflowRun", () => {
    it("cancels a running workflow run", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wr-1", state: "running" }]),
        }),
      });

      const updated = { id: "wr-1", state: "failed", errorMessage: "Cancelled by user" };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await cancelWorkflowRun("wr-1");
      expect(result).toEqual(updated);
    });

    it("cancels a queued workflow run", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wr-1", state: "queued" }]),
        }),
      });

      const updated = { id: "wr-1", state: "failed", errorMessage: "Cancelled by user" };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await cancelWorkflowRun("wr-1");
      expect(result).toEqual(updated);
    });

    it("throws when run is not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(cancelWorkflowRun("nonexistent")).rejects.toThrow("Workflow run not found");
    });

    it("throws when run is already completed", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wr-1", state: "completed" }]),
        }),
      });

      await expect(cancelWorkflowRun("wr-1")).rejects.toThrow(/Cannot cancel/);
    });
  });

  describe("getWorkflowRunLogs", () => {
    it("returns logs for a workflow run", async () => {
      const logs = [
        { id: "l-1", content: "Hello", stream: "stdout" },
        { id: "l-2", content: "Error!", stream: "stderr" },
      ];
      const mockLimit = vi.fn().mockResolvedValue(logs);
      const mock$dynamic = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockOrderBy = vi.fn().mockReturnValue({ $dynamic: mock$dynamic });
      const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      (db.select as any) = vi.fn().mockReturnValue({ from: mockFrom });

      const result = await getWorkflowRunLogs("wr-1", { limit: 50 });
      expect(result).toEqual(logs);
      expect(mockLimit).toHaveBeenCalledWith(50);
    });

    it("returns all logs when no limit specified", async () => {
      const logs = [{ id: "l-1", content: "Hello" }];
      const mock$dynamic = vi.fn().mockResolvedValue(logs);
      const mockOrderBy = vi.fn().mockReturnValue({ $dynamic: mock$dynamic });
      const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      (db.select as any) = vi.fn().mockReturnValue({ from: mockFrom });

      const result = await getWorkflowRunLogs("wr-1");
      expect(result).toEqual(logs);
    });
  });

  describe("insertWorkflowRunLog", () => {
    it("inserts a log entry and returns it", async () => {
      const log = {
        id: "l-1",
        workflowRunId: "wr-1",
        stream: "stdout",
        content: "Hello world",
        logType: "text",
        metadata: null,
        timestamp: new Date(),
      };
      // A Job run's lines are task_logs rows keyed by the run.
      const { workflowRunId, ...row } = log;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...row, taskId: workflowRunId }]),
        }),
      });

      const result = await insertWorkflowRunLog({
        workflowRunId: "wr-1",
        content: "Hello world",
        logType: "text",
      });
      expect(result).toEqual(log);
    });

    it("defaults stream to stdout", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "l-1", ...vals }]) };
        }),
      });

      await insertWorkflowRunLog({
        workflowRunId: "wr-1",
        content: "test",
      });
      expect(capturedValues.stream).toBe("stdout");
    });
  });

  describe("appendWorkflowRunLog", () => {
    it("inserts log and publishes event", async () => {
      const log = {
        id: "l-1",
        workflowRunId: "wr-1",
        stream: "stdout",
        content: "Running tests...",
        logType: "text",
        metadata: null,
        timestamp: new Date("2026-01-01"),
      };
      const { workflowRunId, ...row } = log;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...row, taskId: workflowRunId }]),
        }),
      });

      const result = await appendWorkflowRunLog({
        workflowRunId: "wr-1",
        content: "Running tests...",
        logType: "text",
      });

      expect(result).toEqual(log);
      expect(mockPublishWorkflowRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "workflow_run:log",
          workflowRunId: "wr-1",
          stream: "stdout",
          content: "Running tests...",
        }),
      );
    });
  });
});
