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
  workflows: {
    id: "workflows.id",
    workspaceId: "workflows.workspace_id",
    createdAt: "workflows.created_at",
    enabled: "workflows.enabled",
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
    type: "workflow_triggers.type",
  },
  taskLogs: {
    id: "task_logs.id",
    taskId: "task_logs.task_id",
    workflowRunId: "task_logs.workflow_run_id",
    logType: "task_logs.log_type",
    timestamp: "task_logs.timestamp",
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
} from "./workflow-service.js";

describe("workflow-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listWorkflows", () => {
    it("lists all workflows ordered by createdAt", async () => {
      const items = [{ id: "w-1", name: "Deploy" }];
      const mockWhere = vi.fn().mockResolvedValue(items);
      const mockOrderBy = vi.fn().mockReturnValue({ where: mockWhere });
      const mockFrom = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      (db.select as any) = vi.fn().mockReturnValue({ from: mockFrom });

      mockOrderBy.mockResolvedValue(items);

      const result = await listWorkflows();
      expect(result).toEqual(items);
    });

    it("filters by workspaceId when provided", async () => {
      const items = [{ id: "w-1", name: "Deploy" }];
      const mockWhere = vi.fn().mockResolvedValue(items);
      const mockOrderBy = vi.fn().mockReturnValue({ where: mockWhere });
      const mockFrom = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      (db.select as any) = vi.fn().mockReturnValue({ from: mockFrom });

      const result = await listWorkflows("ws-1");
      expect(mockWhere).toHaveBeenCalled();
    });
  });

  describe("getWorkflow", () => {
    it("returns workflow when found", async () => {
      const workflow = { id: "w-1", name: "Deploy" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([workflow]),
        }),
      });

      const result = await getWorkflow("w-1");
      expect(result).toEqual(workflow);
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getWorkflow("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createWorkflow", () => {
    it("creates a workflow with required fields", async () => {
      const created = { id: "w-1", name: "Pipeline", promptTemplate: "Do it" };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      });

      const result = await createWorkflow({
        name: "Pipeline",
        promptTemplate: "Do it",
      });

      expect(result).toEqual(created);
    });

    it("passes all optional fields through", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "w-1", ...vals }]) };
        }),
      });

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

      expect(capturedValues.model).toBe("opus");
      expect(capturedValues.maxTurns).toBe(10);
      expect(capturedValues.maxConcurrent).toBe(4);
      expect(capturedValues.enabled).toBe(false);
    });

    it("uses defaults for optional fields", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "w-1", ...vals }]) };
        }),
      });

      await createWorkflow({
        name: "Minimal",
        promptTemplate: "Do it",
      });

      expect(capturedValues.agentRuntime).toBe("claude-code");
      expect(capturedValues.maxConcurrent).toBe(2);
      expect(capturedValues.maxRetries).toBe(1);
      expect(capturedValues.warmPoolSize).toBe(0);
      expect(capturedValues.enabled).toBe(true);
    });
  });

  describe("updateWorkflow", () => {
    it("updates workflow fields", async () => {
      const updated = { id: "w-1", name: "Updated" };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await updateWorkflow("w-1", { name: "Updated" });
      expect(result).toEqual(updated);
    });

    it("returns null when workflow not found", async () => {
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await updateWorkflow("nonexistent", { name: "X" });
      expect(result).toBeNull();
    });
  });

  describe("deleteWorkflow", () => {
    it("returns true when workflow is deleted", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "w-1" }]),
        }),
      });

      const result = await deleteWorkflow("w-1");
      expect(result).toBe(true);
    });

    it("returns false when workflow not found", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await deleteWorkflow("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("listWorkflowsWithStats", () => {
    function mockTriggerQuery(triggers: Array<{ workflowId: string; type: string }>) {
      const mockWhere = vi.fn().mockResolvedValue(triggers);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      (db.select as any) = vi.fn().mockReturnValue({ from: mockFrom });
    }

    it("returns workflows with aggregate stats", async () => {
      (db.execute as any) = vi.fn().mockResolvedValue([
        {
          id: "w-1",
          name: "Deploy Pipeline",
          description: "Deploy to prod",
          workspace_id: "ws-1",
          prompt_template: "Deploy {{REPO_NAME}}",
          params_schema: null,
          agent_runtime: "claude-code",
          model: null,
          max_turns: null,
          budget_usd: null,
          max_concurrent: 2,
          max_retries: 1,
          warm_pool_size: 0,
          enabled: true,
          environment_spec: null,
          created_by: "u-1",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          run_count: "3",
          last_run_at: "2026-01-15T00:00:00Z",
          total_cost_usd: "4.5000",
        },
      ]);
      mockTriggerQuery([
        { workflowId: "w-1", type: "manual" },
        { workflowId: "w-1", type: "schedule" },
      ]);

      const result = await listWorkflowsWithStats("ws-1");

      expect(db.execute).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].runCount).toBe(3);
      expect(result[0].lastRunAt).toBe("2026-01-15T00:00:00Z");
      expect(result[0].totalCostUsd).toBe("4.5000");
      expect(result[0].name).toBe("Deploy Pipeline");
      expect(result[0].triggerTypes).toEqual(["manual", "schedule"]);
    });

    it("returns empty array when no workflows exist", async () => {
      (db.execute as any) = vi.fn().mockResolvedValue([]);

      const result = await listWorkflowsWithStats();

      expect(result).toEqual([]);
    });

    it("maps zero stats for workflows with no runs", async () => {
      (db.execute as any) = vi.fn().mockResolvedValue([
        {
          id: "w-2",
          name: "Empty",
          description: null,
          workspace_id: null,
          prompt_template: "...",
          params_schema: null,
          agent_runtime: "claude-code",
          model: null,
          max_turns: null,
          budget_usd: null,
          max_concurrent: 2,
          max_retries: 1,
          warm_pool_size: 0,
          enabled: true,
          environment_spec: null,
          created_by: null,
          created_at: "2026-02-01T00:00:00Z",
          updated_at: "2026-02-01T00:00:00Z",
          run_count: "0",
          last_run_at: null,
          total_cost_usd: "0",
        },
      ]);
      mockTriggerQuery([]);

      const result = await listWorkflowsWithStats();

      expect(result[0].runCount).toBe(0);
      expect(result[0].lastRunAt).toBeNull();
      expect(result[0].totalCostUsd).toBe("0");
      expect(result[0].triggerTypes).toEqual([]);
    });
  });

  describe("getWorkflowWithStats", () => {
    it("returns workflow with stats when found", async () => {
      const workflow = {
        id: "w-1",
        name: "Deploy",
        description: null,
        promptTemplate: "Deploy it",
        agentRuntime: "claude-code",
        maxConcurrent: 2,
        maxRetries: 1,
        warmPoolSize: 0,
        enabled: true,
        createdBy: null,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
        workspaceId: null,
      };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([workflow]),
        }),
      });

      (db.execute as any) = vi.fn().mockResolvedValue([
        {
          run_count: "5",
          last_run_at: "2026-01-20T00:00:00Z",
          total_cost_usd: "10.0000",
        },
      ]);

      const result = await getWorkflowWithStats("w-1");

      expect(result).not.toBeNull();
      expect(result!.runCount).toBe(5);
      expect(result!.lastRunAt).toBe("2026-01-20T00:00:00Z");
      expect(result!.totalCostUsd).toBe("10.0000");
      expect(result!.name).toBe("Deploy");
    });

    it("returns null when workflow not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getWorkflowWithStats("nonexistent");

      expect(result).toBeNull();
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("handles missing stats row gracefully", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "w-1",
              name: "Test",
              description: null,
              promptTemplate: "...",
              agentRuntime: "claude-code",
              maxConcurrent: 2,
              maxRetries: 1,
              warmPoolSize: 0,
              enabled: true,
              createdBy: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              workspaceId: null,
            },
          ]),
        }),
      });

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

  describe("createWorkflowRun", () => {
    it("creates a run for an enabled workflow", async () => {
      // First call: getWorkflow
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wf-1", enabled: true }]),
        }),
      });

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
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(createWorkflowRun("nonexistent")).rejects.toThrow("Workflow not found");
    });

    it("throws when workflow is disabled", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wf-1", enabled: false }]),
        }),
      });

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
      const mockLogs = [
        { id: "l-1", taskId: "t-1", content: "Building..." },
        { id: "l-2", taskId: "t-2", content: "Testing..." },
      ];

      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              // getWorkflowRun
              return Promise.resolve([{ id: "wr-1", state: "running" }]);
            }
            // getWorkflowRunLogs query
            return {
              orderBy: vi.fn().mockResolvedValue(mockLogs),
            };
          }),
        }),
      }));

      const result = await getWorkflowRunLogs("wr-1", {});
      expect(result).toEqual(mockLogs);
    });

    it("throws when run is not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(getWorkflowRunLogs("nonexistent", {})).rejects.toThrow("Workflow run not found");
    });
  });
});
