import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  promptTemplates: {
    id: "prompt_templates.id",
    isDefault: "prompt_templates.is_default",
    repoUrl: "prompt_templates.repo_url",
  },
  repos: {
    id: "repos.id",
    repoUrl: "repos.repo_url",
  },
}));

import { db } from "../db/client.js";
import {
  getPromptTemplate,
  saveDefaultPromptTemplate,
  saveRepoPromptTemplate,
  listPromptTemplates,
} from "./prompt-template-service.js";

describe("prompt-template-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getPromptTemplate", () => {
    it("returns repo-level override when available", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "repo-1",
              promptTemplateOverride: "Custom prompt",
              autoMerge: true,
            },
          ]),
        }),
      });

      const result = await getPromptTemplate("https://github.com/o/r");
      expect(result.template).toBe("Custom prompt");
      expect(result.autoMerge).toBe(true);
    });

    it("falls back to global default when no repo override", async () => {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              // Repo lookup — no override
              return Promise.resolve([
                { id: "repo-1", promptTemplateOverride: null, autoMerge: true },
              ]);
            }
            // Global default lookup
            return Promise.resolve([{ id: "pt-1", template: "Global template", autoMerge: false }]);
          }),
        }),
      }));

      const result = await getPromptTemplate("https://github.com/o/r");
      expect(result.template).toBe("Global template");
      expect(result.autoMerge).toBe(true); // Uses repo's autoMerge
    });

    it("falls back to hardcoded default when no global template", async () => {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            // All lookups return empty
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await getPromptTemplate("https://github.com/o/r");
      expect(result.id).toBe("builtin");
      expect(result.template).toBeDefined();
      expect(result.autoMerge).toBe(false);
    });

    it("returns global default when no repoUrl provided", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "pt-1", template: "Default", autoMerge: false }]),
        }),
      });

      const result = await getPromptTemplate();
      expect(result.template).toBe("Default");
    });
  });

  describe("saveDefaultPromptTemplate", () => {
    it("updates existing default template", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "pt-1" }]),
        }),
      });

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await saveDefaultPromptTemplate("New template", true);
      expect(db.update).toHaveBeenCalled();
    });

    it("inserts new default template when none exists", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      await saveDefaultPromptTemplate("New template", false);
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe("saveRepoPromptTemplate", () => {
    it("updates existing repo template", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "pt-1" }]),
        }),
      });

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await saveRepoPromptTemplate("https://github.com/o/r", "Template", true);
      expect(db.update).toHaveBeenCalled();
    });

    it("inserts new repo template when none exists", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return Promise.resolve(undefined);
        }),
      });

      await saveRepoPromptTemplate("https://github.com/o/r.git", "Template", false);

      expect(db.insert).toHaveBeenCalled();
      // URL should be normalized
      expect(capturedValues.repoUrl).toBe("https://github.com/o/r");
    });
  });

  describe("listPromptTemplates", () => {
    it("returns all prompt templates", async () => {
      const templates = [{ id: "pt-1" }, { id: "pt-2" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(templates),
      });

      const result = await listPromptTemplates();
      expect(result).toEqual(templates);
    });
  });
});
