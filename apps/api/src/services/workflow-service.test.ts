import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  workflows: {
    id: "workflows.id",
    workspaceId: "workflows.workspace_id",
    createdAt: "workflows.created_at",
  },
  workflowTriggers: {
    id: "workflow_triggers.id",
    workflowId: "workflow_triggers.workflow_id",
    createdAt: "workflow_triggers.created_at",
  },
  workflowRuns: {
    id: "workflow_runs.id",
    workflowId: "workflow_runs.workflow_id",
    state: "workflow_runs.state",
    createdAt: "workflow_runs.created_at",
  },
  workflowPods: {
    id: "workflow_pods.id",
    workflowId: "workflow_pods.workflow_id",
    createdAt: "workflow_pods.created_at",
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("@optio/shared", async () => {
  const actual = await vi.importActual("@optio/shared");
  return { ...actual };
});

import { db } from "../db/client.js";
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listWorkflowTriggers,
  createWorkflowTrigger,
  deleteWorkflowTrigger,
  listWorkflowRuns,
  getWorkflowRun,
  createWorkflowRun,
  transitionWorkflowRun,
  listWorkflowPods,
  getWorkflowPod,
  createWorkflowPod,
  deleteWorkflowPod,
} from "./workflow-service.js";

describe("workflow-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Workflow CRUD ──────────────────────────────────────────────────────────

  describe("listWorkflows", () => {
    it("lists all workflows ordered by createdAt", async () => {
      const items = [{ id: "wf-1", name: "Deploy" }];
      const mockWhere = vi.fn().mockResolvedValue(items);
      const mockOrderBy = vi.fn().mockReturnValue({ where: mockWhere });
      const mockFrom = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      (db.select as any) = vi.fn().mockReturnValue({ from: mockFrom });

      mockOrderBy.mockResolvedValue(items);
      const result = await listWorkflows();
      expect(result).toEqual(items);
    });

    it("filters by workspaceId when provided", async () => {
      const items = [{ id: "wf-1", name: "Deploy" }];
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
      const workflow = { id: "wf-1", name: "Deploy" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([workflow]),
        }),
      });

      const result = await getWorkflow("wf-1");
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
      const created = { id: "wf-1", name: "Pipeline", promptTemplate: "Do stuff" };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      });

      const result = await createWorkflow({
        name: "Pipeline",
        promptTemplate: "Do stuff",
      });

      expect(result).toEqual(created);
    });

    it("uses default values for optional fields", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "wf-1", ...vals }]) };
        }),
      });

      await createWorkflow({
        name: "Test",
        promptTemplate: "Do it",
      });

      expect(capturedValues.agentRuntime).toBe("claude-code");
      expect(capturedValues.maxConcurrent).toBe(1);
      expect(capturedValues.maxRetries).toBe(3);
      expect(capturedValues.warmPoolSize).toBe(0);
      expect(capturedValues.enabled).toBe(true);
    });
  });

  describe("updateWorkflow", () => {
    it("updates workflow fields", async () => {
      const updated = { id: "wf-1", name: "Updated" };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await updateWorkflow("wf-1", { name: "Updated" });
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
    it("returns true when deleted", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "wf-1" }]),
        }),
      });

      const result = await deleteWorkflow("wf-1");
      expect(result).toBe(true);
    });

    it("returns false when not found", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await deleteWorkflow("nonexistent");
      expect(result).toBe(false);
    });
  });

  // ── Workflow Triggers ──────────────────────────────────────────────────────

  describe("createWorkflowTrigger", () => {
    it("creates a trigger", async () => {
      const created = { id: "tr-1", workflowId: "wf-1", type: "manual" };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      });

      const result = await createWorkflowTrigger({
        workflowId: "wf-1",
        type: "manual",
      });
      expect(result).toEqual(created);
    });
  });

  describe("deleteWorkflowTrigger", () => {
    it("returns true when deleted", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "tr-1" }]),
        }),
      });

      const result = await deleteWorkflowTrigger("tr-1");
      expect(result).toBe(true);
    });
  });

  // ── Workflow Runs ──────────────────────────────────────────────────────────

  describe("listWorkflowRuns", () => {
    it("lists runs for a workflow", async () => {
      const runs = [{ id: "wr-1" }, { id: "wr-2" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(runs),
          }),
        }),
      });

      const result = await listWorkflowRuns("wf-1");
      expect(result).toEqual(runs);
    });
  });

  describe("getWorkflowRun", () => {
    it("returns run when found", async () => {
      const run = { id: "wr-1", state: "queued" };
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
      // Mock getWorkflow
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wf-1", enabled: true }]),
        }),
      });

      // Mock insert
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue([{ id: "wr-1", workflowId: "wf-1", state: "queued" }]),
        }),
      });

      const result = await createWorkflowRun({ workflowId: "wf-1" });
      expect(result.state).toBe("queued");
    });

    it("throws when workflow not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(createWorkflowRun({ workflowId: "nonexistent" })).rejects.toThrow(
        "Workflow not found",
      );
    });

    it("throws when workflow is disabled", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wf-1", enabled: false }]),
        }),
      });

      await expect(createWorkflowRun({ workflowId: "wf-1" })).rejects.toThrow(
        "Workflow is disabled",
      );
    });
  });

  describe("transitionWorkflowRun", () => {
    it("transitions from queued to running", async () => {
      // Mock getWorkflowRun
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wr-1", state: "queued", retryCount: 0 }]),
        }),
      });

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await expect(transitionWorkflowRun("wr-1", "running" as any)).resolves.not.toThrow();
      expect(db.update).toHaveBeenCalled();
    });

    it("throws on invalid transition", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wr-1", state: "completed", retryCount: 0 }]),
        }),
      });

      await expect(transitionWorkflowRun("wr-1", "running" as any)).rejects.toThrow(
        /Invalid workflow state transition/,
      );
    });

    it("throws when run not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(transitionWorkflowRun("nonexistent", "running" as any)).rejects.toThrow(
        "Workflow run not found",
      );
    });
  });

  // ── Workflow Pods ──────────────────────────────────────────────────────────

  describe("createWorkflowPod", () => {
    it("creates a pod", async () => {
      const created = { id: "wp-1", workflowId: "wf-1", state: "provisioning" };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      });

      const result = await createWorkflowPod({ workflowId: "wf-1" });
      expect(result).toEqual(created);
    });
  });

  describe("deleteWorkflowPod", () => {
    it("returns true when deleted", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "wp-1" }]),
        }),
      });

      const result = await deleteWorkflowPod("wp-1");
      expect(result).toBe(true);
    });
  });
});
