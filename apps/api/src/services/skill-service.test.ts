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
  customSkills: {
    id: "custom_skills.id",
    scope: "custom_skills.scope",
    workspaceId: "custom_skills.workspace_id",
    enabled: "custom_skills.enabled",
  },
}));

import { db } from "../db/client.js";
import {
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  getSkillsForTask,
  buildSkillSetupFiles,
} from "./skill-service.js";

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  id: "skill-1",
  name: "test-skill",
  description: "A test skill",
  prompt: "Do the thing",
  scope: "global",
  repoUrl: null,
  workspaceId: null,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("skill-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listSkills", () => {
    it("lists all skills with no filters", async () => {
      const rows = [makeRow()];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(rows),
      });

      const result = await listSkills();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("test-skill");
    });

    it("filters by scope and workspaceId", async () => {
      const rows = [makeRow()];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      });

      const result = await listSkills("global", "ws-1");
      expect(result).toHaveLength(1);
    });
  });

  describe("getSkill", () => {
    it("returns skill when found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([makeRow()]),
        }),
      });

      const result = await getSkill("skill-1");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("test-skill");
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getSkill("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createSkill", () => {
    it("creates a global skill with defaults", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([makeRow()]) };
        }),
      });

      const result = await createSkill({
        name: "test-skill",
        prompt: "Do the thing",
      });

      expect(capturedValues.scope).toBe("global");
      expect(capturedValues.enabled).toBe(true);
      expect(result.name).toBe("test-skill");
    });

    it("creates a repo-scoped skill", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return {
            returning: vi
              .fn()
              .mockResolvedValue([
                makeRow({ scope: "https://github.com/o/r", repoUrl: "https://github.com/o/r" }),
              ]),
          };
        }),
      });

      await createSkill({
        name: "repo-skill",
        prompt: "Do it",
        repoUrl: "https://github.com/o/r",
      });

      expect(capturedValues.scope).toBe("https://github.com/o/r");
      expect(capturedValues.repoUrl).toBe("https://github.com/o/r");
    });
  });

  describe("updateSkill", () => {
    it("updates specified fields", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([makeRow({ name: "updated" })]),
            }),
          };
        }),
      });

      const result = await updateSkill("skill-1", { name: "updated" });
      expect(capturedSet.name).toBe("updated");
      expect(capturedSet.updatedAt).toBeInstanceOf(Date);
      expect(result.name).toBe("updated");
    });

    it("does not include undefined fields", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([makeRow()]),
            }),
          };
        }),
      });

      await updateSkill("skill-1", { enabled: false });
      expect(capturedSet.enabled).toBe(false);
      expect(capturedSet.name).toBeUndefined();
      expect(capturedSet.prompt).toBeUndefined();
    });
  });

  describe("deleteSkill", () => {
    it("deletes a skill", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await deleteSkill("skill-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("getSkillsForTask", () => {
    it("returns enabled skills with repo overrides", async () => {
      const globalRow = makeRow({ id: "s-g", name: "deploy", scope: "global" });
      const repoRow = makeRow({
        id: "s-r",
        name: "deploy",
        scope: "https://github.com/o/r",
      });
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([globalRow, repoRow]),
        }),
      });

      const result = await getSkillsForTask("https://github.com/o/r");
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe("https://github.com/o/r");
    });

    it("keeps global skills when no repo override", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([makeRow({ scope: "global" })]),
        }),
      });

      const result = await getSkillsForTask("https://github.com/o/r");
      expect(result).toHaveLength(1);
      expect(result[0].scope).toBe("global");
    });

    it("returns multiple skills with different names", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              makeRow({ id: "s-1", name: "deploy", scope: "global" }),
              makeRow({ id: "s-2", name: "test", scope: "global" }),
            ]),
        }),
      });

      const result = await getSkillsForTask("https://github.com/o/r");
      expect(result).toHaveLength(2);
    });
  });

  describe("buildSkillSetupFiles", () => {
    it("creates .claude/commands/ files for each skill", () => {
      const skills = [
        {
          id: "s-1",
          name: "deploy",
          description: null,
          prompt: "Deploy the app",
          scope: "global",
          repoUrl: null,
          workspaceId: null,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "s-2",
          name: "test",
          description: null,
          prompt: "Run tests",
          scope: "global",
          repoUrl: null,
          workspaceId: null,
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const files = buildSkillSetupFiles(skills);

      expect(files).toHaveLength(2);
      expect(files[0].path).toBe(".claude/commands/deploy.md");
      expect(files[0].content).toBe("Deploy the app");
      expect(files[1].path).toBe(".claude/commands/test.md");
      expect(files[1].content).toBe("Run tests");
    });

    it("returns empty array for no skills", () => {
      const files = buildSkillSetupFiles([]);
      expect(files).toEqual([]);
    });
  });
});
