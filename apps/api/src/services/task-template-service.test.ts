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
  taskTemplates: {
    id: "task_templates.id",
    repoUrl: "task_templates.repo_url",
  },
}));

import { db } from "../db/client.js";
import {
  listTaskTemplates,
  getTaskTemplate,
  createTaskTemplate,
  updateTaskTemplate,
  deleteTaskTemplate,
} from "./task-template-service.js";

describe("task-template-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listTaskTemplates", () => {
    it("lists all templates without filter", async () => {
      const templates = [{ id: "tt-1", name: "Build" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(templates),
      });

      const result = await listTaskTemplates();
      expect(result).toEqual(templates);
    });

    it("filters by repoUrl", async () => {
      const templates = [{ id: "tt-1" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(templates),
        }),
      });

      const result = await listTaskTemplates("https://github.com/o/r");
      expect(result).toEqual(templates);
    });
  });

  describe("getTaskTemplate", () => {
    it("returns template when found", async () => {
      const template = { id: "tt-1", name: "Build" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([template]),
        }),
      });

      const result = await getTaskTemplate("tt-1");
      expect(result).toEqual(template);
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getTaskTemplate("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createTaskTemplate", () => {
    it("creates template with defaults", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "tt-1", ...vals }]) };
        }),
      });

      const result = await createTaskTemplate({
        name: "Build",
        prompt: "Build the app",
      });

      expect(capturedValues.agentType).toBe("claude-code");
      expect(capturedValues.priority).toBe(100);
      expect(capturedValues.repoUrl).toBeNull();
    });

    it("uses provided values", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "tt-1" }]) };
        }),
      });

      await createTaskTemplate({
        name: "Test",
        prompt: "Run tests",
        agentType: "codex",
        priority: 50,
        repoUrl: "https://github.com/o/r",
        metadata: { key: "value" },
      });

      expect(capturedValues.agentType).toBe("codex");
      expect(capturedValues.priority).toBe(50);
      expect(capturedValues.repoUrl).toBe("https://github.com/o/r");
      expect(capturedValues.metadata).toEqual({ key: "value" });
    });
  });

  describe("updateTaskTemplate", () => {
    it("updates template fields", async () => {
      const updated = { id: "tt-1", name: "Updated" };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await updateTaskTemplate("tt-1", { name: "Updated" });
      expect(result!.name).toBe("Updated");
    });

    it("returns null when not found", async () => {
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await updateTaskTemplate("nonexistent", { name: "X" });
      expect(result).toBeNull();
    });
  });

  describe("deleteTaskTemplate", () => {
    it("deletes a template", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await deleteTaskTemplate("tt-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });
});
