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
    enabled: "workflow_triggers.enabled",
    nextFireAt: "workflow_triggers.next_fire_at",
    createdAt: "workflow_triggers.created_at",
  },
  taskLogs: {
    id: "task_logs.id",
    taskId: "task_logs.task_id",
    workflowRunId: "task_logs.workflow_run_id",
    logType: "task_logs.log_type",
    timestamp: "task_logs.timestamp",
  },
  workflowRunLogs: {
    id: "workflow_run_logs.id",
    workflowRunId: "workflow_run_logs.workflow_run_id",
    logType: "workflow_run_logs.log_type",
    timestamp: "workflow_run_logs.timestamp",
  },
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
  listWorkflowTriggers,
  createWorkflowTrigger,
  getWorkflowTrigger,
  updateWorkflowTrigger,
  deleteWorkflowTrigger,
  getDueScheduleTriggers,
  markTriggerFired,
  insertWorkflowRunLog,
  transitionWorkflowRunState,
  appendWorkflowRunLog,
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

  // ── Workflow Trigger CRUD ───────────────────────────────────────────────────

  describe("createWorkflowTrigger", () => {
    it("creates a schedule trigger with computed nextFireAt", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "t-1", ...vals }]) };
        }),
      });

      const result = await createWorkflowTrigger({
        workflowId: "w-1",
        type: "schedule",
        config: { cronExpression: "0 0 * * *" },
      });

      expect(capturedValues.type).toBe("schedule");
      expect(capturedValues.enabled).toBe(true);
      expect(capturedValues.nextFireAt).toBeInstanceOf(Date);
    });

    it("creates a manual trigger without nextFireAt", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "t-2", ...vals }]) };
        }),
      });

      await createWorkflowTrigger({
        workflowId: "w-1",
        type: "manual",
      });

      expect(capturedValues.nextFireAt).toBeNull();
    });

    it("sets nextFireAt to null when disabled", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "t-3", ...vals }]) };
        }),
      });

      await createWorkflowTrigger({
        workflowId: "w-1",
        type: "schedule",
        config: { cronExpression: "0 0 * * *" },
        enabled: false,
      });

      expect(capturedValues.nextFireAt).toBeNull();
    });
  });

  describe("getWorkflowTrigger", () => {
    it("returns trigger when found", async () => {
      const trigger = { id: "t-1", type: "schedule" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([trigger]),
        }),
      });

      const result = await getWorkflowTrigger("t-1");
      expect(result).toEqual(trigger);
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getWorkflowTrigger("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("updateWorkflowTrigger", () => {
    it("updates and recomputes nextFireAt for schedule trigger", async () => {
      // Mock getWorkflowTrigger
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "t-1",
              type: "schedule",
              config: { cronExpression: "0 0 * * *" },
              enabled: true,
            },
          ]),
        }),
      });

      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "t-1" }]),
            }),
          };
        }),
      });

      await updateWorkflowTrigger("t-1", {
        config: { cronExpression: "*/5 * * * *" },
      });

      expect(capturedSet.config).toEqual({ cronExpression: "*/5 * * * *" });
      expect(capturedSet.nextFireAt).toBeInstanceOf(Date);
    });

    it("clears nextFireAt when disabling a schedule trigger", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "t-1",
              type: "schedule",
              config: { cronExpression: "0 0 * * *" },
              enabled: true,
            },
          ]),
        }),
      });

      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "t-1" }]),
            }),
          };
        }),
      });

      await updateWorkflowTrigger("t-1", { enabled: false });

      expect(capturedSet.nextFireAt).toBeNull();
    });

    it("returns null when trigger not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await updateWorkflowTrigger("nonexistent", { enabled: false });
      expect(result).toBeNull();
    });
  });

  describe("deleteWorkflowTrigger", () => {
    it("returns true when deleted", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "t-1" }]),
        }),
      });

      const result = await deleteWorkflowTrigger("t-1");
      expect(result).toBe(true);
    });

    it("returns false when not found", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await deleteWorkflowTrigger("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("markTriggerFired", () => {
    it("updates lastFiredAt and computes new nextFireAt", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      });

      await markTriggerFired("t-1", "0 0 * * *");

      expect(capturedSet.lastFiredAt).toBeInstanceOf(Date);
      expect(capturedSet.nextFireAt).toBeInstanceOf(Date);
      expect(capturedSet.nextFireAt.getTime()).toBeGreaterThan(capturedSet.lastFiredAt.getTime());
    });
  });

  describe("getDueScheduleTriggers", () => {
    it("queries for enabled schedule triggers past their nextFireAt", async () => {
      const rows = [
        {
          trigger: { id: "t-1", type: "schedule" },
          workflow: { id: "w-1", name: "Deploy" },
        },
      ];
      const mockWhere = vi.fn().mockResolvedValue(rows);
      const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere });
      const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin });
      (db.select as any) = vi.fn().mockReturnValue({ from: mockFrom });

      const result = await getDueScheduleTriggers();
      expect(result).toEqual(rows);
    });
  });

  describe("createWorkflowRun", () => {
    it("creates a run for an enabled workflow", async () => {
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
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([log]),
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

  describe("transitionWorkflowRunState", () => {
    it("transitions state and publishes event", async () => {
      const run = { id: "wr-1", workflowId: "w-1", state: "queued" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([run]),
        }),
      });
      const mockSet = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      (db.update as any) = vi.fn().mockReturnValue({ set: mockSet });

      await transitionWorkflowRunState("wr-1", "running" as any);

      expect(db.update).toHaveBeenCalled();
      expect(mockPublishWorkflowRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "workflow_run:state_changed",
          workflowRunId: "wr-1",
          workflowId: "w-1",
          fromState: "queued",
          toState: "running",
        }),
      );
    });

    it("throws when workflow run not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(transitionWorkflowRunState("nonexistent", "running" as any)).rejects.toThrow(
        "Workflow run nonexistent not found",
      );
    });

    it("throws on invalid state transition", async () => {
      const run = { id: "wr-1", workflowId: "w-1", state: "completed" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([run]),
        }),
      });

      await expect(transitionWorkflowRunState("wr-1", "running" as any)).rejects.toThrow(
        "Invalid workflow run transition",
      );
    });

    it("includes extras in the published event", async () => {
      const run = { id: "wr-1", workflowId: "w-1", state: "running" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([run]),
        }),
      });
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await transitionWorkflowRunState("wr-1", "completed" as any, {
        costUsd: "1.50",
        modelUsed: "claude-sonnet",
      });

      expect(mockPublishWorkflowRunEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          costUsd: "1.50",
          modelUsed: "claude-sonnet",
        }),
      );
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
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([log]),
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

  // ── Workflow Triggers ──────────────────────────────────────────────────

  describe("listWorkflowTriggers", () => {
    it("lists triggers for a workflow", async () => {
      const triggers = [
        { id: "t-1", type: "manual" },
        { id: "t-2", type: "schedule" },
      ];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(triggers),
          }),
        }),
      });

      const result = await listWorkflowTriggers("w-1");
      expect(result).toEqual(triggers);
    });
  });

  describe("createWorkflowTrigger", () => {
    it("creates a trigger with required fields", async () => {
      const created = { id: "t-1", workflowId: "w-1", type: "schedule" };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      });

      const result = await createWorkflowTrigger({
        workflowId: "w-1",
        type: "schedule",
      });

      expect(result).toEqual(created);
    });

    it("passes config and paramMapping through", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "t-1", ...vals }]) };
        }),
      });

      await createWorkflowTrigger({
        workflowId: "w-1",
        type: "webhook",
        config: { secret: "abc" },
        paramMapping: { REPO: "$.repo" },
        enabled: false,
      });

      expect(capturedValues.config).toEqual({ secret: "abc" });
      expect(capturedValues.paramMapping).toEqual({ REPO: "$.repo" });
      expect(capturedValues.enabled).toBe(false);
    });

    it("defaults enabled to true", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "t-1", ...vals }]) };
        }),
      });

      await createWorkflowTrigger({
        workflowId: "w-1",
        type: "manual",
      });

      expect(capturedValues.enabled).toBe(true);
    });
  });

  describe("updateWorkflowTrigger", () => {
    it("updates a trigger", async () => {
      // Mock getWorkflowTrigger (db.select)
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "t-1", type: "webhook", enabled: true }]),
        }),
      });

      const updated = { id: "t-1", type: "webhook", enabled: false };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await updateWorkflowTrigger("t-1", { enabled: false });
      expect(result).toEqual(updated);
    });

    it("returns null when trigger not found", async () => {
      // Mock getWorkflowTrigger returning null
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await updateWorkflowTrigger("nonexistent", { enabled: true });
      expect(result).toBeNull();
    });
  });

  describe("deleteWorkflowTrigger", () => {
    it("returns true when deleted", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "t-1" }]),
        }),
      });

      const result = await deleteWorkflowTrigger("t-1");
      expect(result).toBe(true);
    });

    it("returns false when not found", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await deleteWorkflowTrigger("nonexistent");
      expect(result).toBe(false);
    });
  });
});
