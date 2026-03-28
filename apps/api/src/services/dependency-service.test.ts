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
  taskDependencies: {
    id: "task_dependencies.id",
    taskId: "task_dependencies.task_id",
    dependsOnTaskId: "task_dependencies.depends_on_task_id",
  },
  tasks: {
    id: "tasks.id",
    title: "tasks.title",
    state: "tasks.state",
    repoUrl: "tasks.repo_url",
    workspaceId: "tasks.workspace_id",
    parentTaskId: "tasks.parent_task_id",
    taskType: "tasks.task_type",
    ignoreOffPeak: "tasks.ignore_off_peak",
  },
  repos: {
    repoUrl: "repos.repo_url",
    workspaceId: "repos.workspace_id",
  },
  workspaces: {
    id: "workspaces.id",
    slug: "workspaces.slug",
  },
}));

vi.mock("./task-service.js", () => ({
  getTask: vi.fn(),
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
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { db } from "../db/client.js";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import {
  addDependencies,
  getDependencies,
  getDependents,
  areDependenciesMet,
  onDependencyComplete,
  cascadeFailure,
  removeDependency,
  computePendingReason,
} from "./dependency-service.js";

describe("dependency-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("addDependencies", () => {
    it("does nothing with empty array", async () => {
      await addDependencies("task-1", []);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("throws on self-dependency", async () => {
      await expect(addDependencies("task-1", ["task-1"])).rejects.toThrow(
        "A task cannot depend on itself",
      );
    });

    it("throws when dependency tasks not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(addDependencies("task-1", ["task-2"])).rejects.toThrow(
        "Dependency tasks not found: task-2",
      );
    });

    it("throws on circular dependency", async () => {
      // Mock: dependency tasks exist
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) {
            // Validate dep tasks exist (uses inArray/where)
            return {
              where: vi.fn().mockResolvedValue([{ id: "task-2" }]),
            };
          }
          // getAllEdges: db.select().from(taskDependencies) — no where, returns directly
          return Promise.resolve([{ taskId: "task-2", dependsOnTaskId: "task-1" }]);
        }),
      }));

      await expect(addDependencies("task-1", ["task-2"])).rejects.toThrow(/[Cc]ircular dependency/);
    });

    it("inserts dependency rows on success", async () => {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) {
            // Validate dep tasks exist (uses where)
            return {
              where: vi.fn().mockResolvedValue([{ id: "task-2" }, { id: "task-3" }]),
            };
          }
          // getAllEdges: returns directly from from()
          return Promise.resolve([]);
        }),
      }));

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      await addDependencies("task-1", ["task-2", "task-3"]);

      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe("getDependencies", () => {
    it("returns tasks that taskId depends on", async () => {
      const deps = [{ id: "dep-1", title: "Dep 1", state: "completed", dependencyId: "d-1" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(deps),
          }),
        }),
      });

      const result = await getDependencies("task-1");
      expect(result).toEqual(deps);
    });
  });

  describe("getDependents", () => {
    it("returns tasks that depend on taskId", async () => {
      const dependents = [
        { id: "t-2", title: "Task 2", state: "waiting_on_deps", dependencyId: "d-1" },
      ];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(dependents),
          }),
        }),
      });

      const result = await getDependents("task-1");
      expect(result).toEqual(dependents);
    });
  });

  describe("areDependenciesMet", () => {
    it("returns true when no dependencies", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await areDependenciesMet("task-1");
      expect(result).toBe(true);
    });

    it("returns true when all deps completed or pr_opened", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: "d-1", state: "completed" },
              { id: "d-2", state: "pr_opened" },
            ]),
          }),
        }),
      });

      const result = await areDependenciesMet("task-1");
      expect(result).toBe(true);
    });

    it("returns false when some deps are still running", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: "d-1", state: "completed" },
              { id: "d-2", state: "running" },
            ]),
          }),
        }),
      });

      const result = await areDependenciesMet("task-1");
      expect(result).toBe(false);
    });
  });

  describe("onDependencyComplete", () => {
    it("queues dependents whose deps are now all met", async () => {
      let innerJoinCallCount = 0;
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              innerJoinCallCount++;
              if (innerJoinCallCount === 1) {
                // getDependents returns one dependent in waiting_on_deps
                return Promise.resolve([
                  { id: "t-2", title: "Task 2", state: "waiting_on_deps", dependencyId: "d-1" },
                ]);
              }
              // areDependenciesMet / getDependencies — all completed
              return Promise.resolve([
                { id: "t-1", title: "Task 1", state: "completed", dependencyId: "d-1" },
              ]);
            }),
          }),
        }),
      });

      await onDependencyComplete("t-1");

      expect(taskService.transitionTask).toHaveBeenCalledWith("t-2", "queued", "dependencies_met");
      expect(taskQueue.add).toHaveBeenCalledWith(
        "process-task",
        { taskId: "t-2" },
        expect.objectContaining({ priority: 100 }),
      );
    });

    it("skips dependents not in waiting_on_deps state", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi
              .fn()
              .mockResolvedValue([
                { id: "t-2", title: "Task 2", state: "running", dependencyId: "d-1" },
              ]),
          }),
        }),
      });

      await onDependencyComplete("t-1");

      expect(taskService.transitionTask).not.toHaveBeenCalled();
    });

    it("handles transition errors gracefully", async () => {
      // getDependents
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi
              .fn()
              .mockResolvedValue([
                { id: "t-2", title: "Task 2", state: "waiting_on_deps", dependencyId: "d-1" },
              ]),
          }),
        }),
      });

      vi.mocked(taskService.transitionTask).mockRejectedValue(new Error("state race"));

      // Should not throw
      await onDependencyComplete("t-1");
    });
  });

  describe("cascadeFailure", () => {
    it("fails dependents in waiting_on_deps recursively", async () => {
      let callCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve([
                  { id: "t-2", title: "Task 2", state: "waiting_on_deps", dependencyId: "d-1" },
                ]);
              }
              // Recursive call for t-2's dependents
              return Promise.resolve([]);
            }),
          }),
        }),
      }));

      await cascadeFailure("t-1");

      expect(taskService.transitionTask).toHaveBeenCalledWith(
        "t-2",
        "failed",
        "dependency_failed",
        "Dependency t-1 failed",
      );
    });

    it("skips dependents not in waiting_on_deps", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi
              .fn()
              .mockResolvedValue([
                { id: "t-2", title: "Task 2", state: "completed", dependencyId: "d-1" },
              ]),
          }),
        }),
      });

      await cascadeFailure("t-1");

      expect(taskService.transitionTask).not.toHaveBeenCalled();
    });
  });

  describe("removeDependency", () => {
    it("returns true when dependency removed", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "d-1" }]),
        }),
      });

      const result = await removeDependency("task-1", "task-2");
      expect(result).toBe(true);
    });

    it("returns false when dependency not found", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await removeDependency("task-1", "task-2");
      expect(result).toBe(false);
    });
  });

  describe("computePendingReason", () => {
    it("returns null when task not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            then: vi.fn().mockImplementation((cb: any) => cb([])),
          }),
        }),
      });

      const result = await computePendingReason("nonexistent");
      expect(result).toBeNull();
    });

    it("returns blocked-by message for unsatisfied deps", async () => {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              // Task lookup
              return {
                then: vi
                  .fn()
                  .mockImplementation((cb: any) => cb([{ id: "t-1", state: "waiting_on_deps" }])),
              };
            }
            // getDependencies (innerJoin path)
            return Promise.resolve([{ id: "d-1", title: "Build", state: "running" }]);
          }),
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: "d-1", title: "Build", state: "running" }]),
          }),
        }),
      }));

      const result = await computePendingReason("t-1");
      expect(result).toContain("Blocked by");
      expect(result).toContain("Build");
    });
  });
});
