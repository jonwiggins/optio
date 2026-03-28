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
  workflowTemplates: {
    id: "workflow_templates.id",
    workspaceId: "workflow_templates.workspace_id",
    createdAt: "workflow_templates.created_at",
  },
  workflowRuns: {
    id: "workflow_runs.id",
    workflowTemplateId: "workflow_runs.workflow_template_id",
    createdAt: "workflow_runs.created_at",
  },
  tasks: {
    id: "tasks.id",
    workflowRunId: "tasks.workflow_run_id",
  },
}));

vi.mock("./task-service.js", () => ({
  getTask: vi.fn(),
  createTask: vi.fn(),
  transitionTask: vi.fn(),
}));

vi.mock("./dependency-service.js", () => ({
  addDependencies: vi.fn(),
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
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Must mock @optio/shared detectCycle
vi.mock("@optio/shared", async () => {
  const actual = await vi.importActual("@optio/shared");
  return {
    ...actual,
  };
});

import { db } from "../db/client.js";
import * as taskService from "./task-service.js";
import * as dependencyService from "./dependency-service.js";
import { taskQueue } from "../workers/task-worker.js";
import {
  listWorkflowTemplates,
  getWorkflowTemplate,
  createWorkflowTemplate,
  updateWorkflowTemplate,
  deleteWorkflowTemplate,
  listWorkflowRuns,
  getWorkflowRun,
  runWorkflow,
  checkWorkflowRunCompletion,
} from "./workflow-service.js";

describe("workflow-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listWorkflowTemplates", () => {
    it("lists all templates ordered by createdAt", async () => {
      const templates = [{ id: "wt-1", name: "Deploy" }];
      const mockWhere = vi.fn().mockResolvedValue(templates);
      const mockOrderBy = vi.fn().mockReturnValue({ where: mockWhere });
      const mockFrom = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      (db.select as any) = vi.fn().mockReturnValue({ from: mockFrom });

      // Without workspaceId, should not call where
      mockOrderBy.mockResolvedValue(templates);
      const result = await listWorkflowTemplates();
      expect(result).toEqual(templates);
    });

    it("filters by workspaceId when provided", async () => {
      const templates = [{ id: "wt-1", name: "Deploy" }];
      const mockWhere = vi.fn().mockResolvedValue(templates);
      const mockOrderBy = vi.fn().mockReturnValue({ where: mockWhere });
      const mockFrom = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
      (db.select as any) = vi.fn().mockReturnValue({ from: mockFrom });

      const result = await listWorkflowTemplates("ws-1");
      expect(mockWhere).toHaveBeenCalled();
    });
  });

  describe("getWorkflowTemplate", () => {
    it("returns template when found", async () => {
      const template = { id: "wt-1", name: "Deploy" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([template]),
        }),
      });

      const result = await getWorkflowTemplate("wt-1");
      expect(result).toEqual(template);
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getWorkflowTemplate("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createWorkflowTemplate", () => {
    it("creates a template with valid DAG", async () => {
      const created = { id: "wt-1", name: "Pipeline", steps: [] };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      });

      const result = await createWorkflowTemplate({
        name: "Pipeline",
        steps: [
          { id: "step-a", title: "Build", prompt: "Build the app" },
          { id: "step-b", title: "Test", prompt: "Run tests", dependsOn: ["step-a"] },
        ],
      });

      expect(result).toEqual(created);
    });

    it("throws on circular dependency", async () => {
      await expect(
        createWorkflowTemplate({
          name: "Bad",
          steps: [
            { id: "a", title: "A", prompt: "...", dependsOn: ["b"] },
            { id: "b", title: "B", prompt: "...", dependsOn: ["a"] },
          ],
        }),
      ).rejects.toThrow(/[Cc]ircular dependency/);
    });

    it("throws on unknown step reference", async () => {
      await expect(
        createWorkflowTemplate({
          name: "Bad",
          steps: [{ id: "a", title: "A", prompt: "...", dependsOn: ["nonexistent"] }],
        }),
      ).rejects.toThrow(/unknown step/);
    });

    it("uses default status 'draft' when not specified", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "wt-1", ...vals }]) };
        }),
      });

      await createWorkflowTemplate({
        name: "Test",
        steps: [{ id: "a", title: "A", prompt: "Do it" }],
      });

      expect(capturedValues.status).toBe("draft");
    });
  });

  describe("updateWorkflowTemplate", () => {
    it("updates template fields", async () => {
      const updated = { id: "wt-1", name: "Updated" };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await updateWorkflowTemplate("wt-1", { name: "Updated" });
      expect(result).toEqual(updated);
    });

    it("validates DAG when steps are updated", async () => {
      await expect(
        updateWorkflowTemplate("wt-1", {
          steps: [
            { id: "a", title: "A", prompt: "...", dependsOn: ["b"] },
            { id: "b", title: "B", prompt: "...", dependsOn: ["a"] },
          ],
        }),
      ).rejects.toThrow(/[Cc]ircular dependency/);
    });

    it("returns null when template not found", async () => {
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await updateWorkflowTemplate("nonexistent", { name: "X" });
      expect(result).toBeNull();
    });
  });

  describe("deleteWorkflowTemplate", () => {
    it("returns true when template is deleted", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "wt-1" }]),
        }),
      });

      const result = await deleteWorkflowTemplate("wt-1");
      expect(result).toBe(true);
    });

    it("returns false when template not found", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await deleteWorkflowTemplate("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("listWorkflowRuns", () => {
    it("lists runs for a template", async () => {
      const runs = [{ id: "wr-1" }, { id: "wr-2" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(runs),
          }),
        }),
      });

      const result = await listWorkflowRuns("wt-1");
      expect(result).toEqual(runs);
    });
  });

  describe("getWorkflowRun", () => {
    it("returns run when found", async () => {
      const run = { id: "wr-1", status: "running" };
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

  describe("runWorkflow", () => {
    it("creates tasks and wires dependencies for a workflow", async () => {
      // Mock getWorkflowTemplate
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "wt-1",
              status: "active",
              steps: [
                {
                  id: "build",
                  title: "Build",
                  prompt: "Build it",
                  repoUrl: "https://github.com/o/r",
                },
                {
                  id: "test",
                  title: "Test",
                  prompt: "Test it",
                  repoUrl: "https://github.com/o/r",
                  dependsOn: ["build"],
                },
              ],
            },
          ]),
        }),
      });

      // Mock insert for workflow run
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "wr-1", taskMapping: {} }]),
        }),
      });

      // Mock update for tasks and workflow run
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      let taskCount = 0;
      vi.mocked(taskService.createTask).mockImplementation(async () => {
        taskCount++;
        return { id: `task-${taskCount}`, maxRetries: 3 } as any;
      });

      const result = await runWorkflow("wt-1");

      expect(taskService.createTask).toHaveBeenCalledTimes(2);
      expect(dependencyService.addDependencies).toHaveBeenCalledWith("task-2", ["task-1"]);
      // Build step has no deps → queued
      expect(taskService.transitionTask).toHaveBeenCalledWith("task-1", "queued", "workflow_start");
      // Test step has deps → waiting_on_deps
      expect(taskService.transitionTask).toHaveBeenCalledWith(
        "task-2",
        "waiting_on_deps",
        "workflow_start",
      );
      expect(taskQueue.add).toHaveBeenCalledTimes(1); // Only root task queued
    });

    it("throws when template not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(runWorkflow("nonexistent")).rejects.toThrow("Workflow template not found");
    });

    it("throws when template is archived", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wt-1", status: "archived", steps: [] }]),
        }),
      });

      await expect(runWorkflow("wt-1")).rejects.toThrow("Cannot run an archived workflow");
    });

    it("throws when step has no repoUrl and no override", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "wt-1",
              status: "active",
              steps: [{ id: "s1", title: "S1", prompt: "..." }],
            },
          ]),
        }),
      });

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "wr-1", taskMapping: {} }]),
        }),
      });

      await expect(runWorkflow("wt-1")).rejects.toThrow(/no repoUrl/);
    });
  });

  describe("checkWorkflowRunCompletion", () => {
    it("marks run as completed when all tasks completed", async () => {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return Promise.resolve([
                { id: "wr-1", status: "running", taskMapping: { a: "t-1", b: "t-2" } },
              ]);
            }
            return Promise.resolve([]);
          }),
        }),
      }));

      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({ id: "t-1", state: "completed" } as any)
        .mockResolvedValueOnce({ id: "t-2", state: "completed" } as any);

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await checkWorkflowRunCompletion("wr-1");

      expect(db.update).toHaveBeenCalled();
    });

    it("marks run as failed when all terminal but some failed", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: "wr-1", status: "running", taskMapping: { a: "t-1", b: "t-2" } },
            ]),
        }),
      });

      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({ id: "t-1", state: "completed" } as any)
        .mockResolvedValueOnce({ id: "t-2", state: "failed" } as any);

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await checkWorkflowRunCompletion("wr-1");

      expect(db.update).toHaveBeenCalled();
    });

    it("does nothing when run is not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await checkWorkflowRunCompletion("nonexistent");

      expect(db.update).not.toHaveBeenCalled();
    });

    it("does nothing when tasks are still running", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: "wr-1", status: "running", taskMapping: { a: "t-1", b: "t-2" } },
            ]),
        }),
      });

      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({ id: "t-1", state: "completed" } as any)
        .mockResolvedValueOnce({ id: "t-2", state: "running" } as any);

      (db.update as any) = vi.fn();

      await checkWorkflowRunCompletion("wr-1");

      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
