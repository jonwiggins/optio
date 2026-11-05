import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// The founding workspace reads every deployment row (services/deployment-defaults.ts).
vi.mock("./founding-workspace.js", () => ({
  foundingWorkspaceId: vi.fn(async () => "ws-founding"),
}));

vi.mock("../db/schema.js", () => ({
  customSkills: {
    id: "custom_skills.id",
    scope: "custom_skills.scope",
    workspaceId: "custom_skills.workspace_id",
    deploymentDefault: "custom_skills.deployment_default",
    enabled: "custom_skills.enabled",
    layout: "custom_skills.layout",
    files: "custom_skills.files",
    agentTypes: "custom_skills.agent_types",
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
  layout: "commands",
  files: null,
  agentTypes: null,
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

    it("filters out skills whose agentTypes don't include the current agent", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              makeRow({ id: "s-1", name: "claude-only", agentTypes: ["claude-code"] }),
              makeRow({ id: "s-2", name: "codex-only", agentTypes: ["codex"] }),
              makeRow({ id: "s-3", name: "any-agent", agentTypes: null }),
            ]),
        }),
      });

      const result = await getSkillsForTask("https://github.com/o/r", null, "claude-code");
      const names = result.map((s) => s.name).sort();
      expect(names).toEqual(["any-agent", "claude-only"]);
    });

    it("treats empty agentTypes array the same as null (all agents)", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([makeRow({ name: "broad", agentTypes: [] })]),
        }),
      });

      const result = await getSkillsForTask("https://github.com/o/r", null, "claude-code");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("broad");
    });

    it("excludes agent-scoped skills when no agentType is provided", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              makeRow({ id: "s-1", name: "scoped", agentTypes: ["claude-code"] }),
              makeRow({ id: "s-2", name: "any", agentTypes: null }),
            ]),
        }),
      });

      const result = await getSkillsForTask("https://github.com/o/r");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("any");
    });

    it("falls back to global skill when matching repo skill is excluded by agent filter", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            makeRow({
              id: "s-g",
              name: "deploy",
              scope: "global",
              agentTypes: null,
            }),
            makeRow({
              id: "s-r",
              name: "deploy",
              scope: "https://github.com/o/r",
              agentTypes: ["codex"], // doesn't match claude-code
            }),
          ]),
        }),
      });

      const result = await getSkillsForTask("https://github.com/o/r", null, "claude-code");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("s-g");
    });
  });

  describe("buildSkillSetupFiles", () => {
    const baseSkill = {
      description: null,
      scope: "global" as const,
      repoUrl: null,
      workspaceId: null,
      layout: "commands" as const,
      files: null,
      agentTypes: null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("creates .claude/commands/ files for commands-layout skills", () => {
      const skills = [
        { ...baseSkill, id: "s-1", name: "deploy", prompt: "Deploy the app" },
        { ...baseSkill, id: "s-2", name: "test", prompt: "Run tests" },
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

    it("emits SKILL.md plus extra files for skill-dir layout", () => {
      const files = buildSkillSetupFiles([
        {
          ...baseSkill,
          id: "s-1",
          name: "review",
          prompt: "review steps",
          layout: "skill-dir",
          files: [
            { relativePath: "reference.md", content: "# Reference" },
            { relativePath: "scripts/lint.sh", content: "#!/bin/sh\necho hi" },
          ],
        },
      ]);

      expect(files).toEqual([
        { path: ".claude/skills/review/SKILL.md", content: "review steps" },
        { path: ".claude/skills/review/reference.md", content: "# Reference" },
        {
          path: ".claude/skills/review/scripts/lint.sh",
          content: "#!/bin/sh\necho hi",
        },
      ]);
    });

    it("rejects extra-file paths that try to escape the skill dir", () => {
      const files = buildSkillSetupFiles([
        {
          ...baseSkill,
          id: "s-1",
          name: "danger",
          prompt: "body",
          layout: "skill-dir",
          files: [
            { relativePath: "../escape.md", content: "nope" },
            { relativePath: "/absolute.md", content: "leading slash stripped" },
            { relativePath: "ok/nested.md", content: "ok" },
            { relativePath: "", content: "empty" },
          ],
        },
      ]);

      const paths = files.map((f) => f.path);
      expect(paths).toContain(".claude/skills/danger/SKILL.md");
      expect(paths).toContain(".claude/skills/danger/absolute.md");
      expect(paths).toContain(".claude/skills/danger/ok/nested.md");
      expect(paths).not.toContain(".claude/skills/danger/../escape.md");
      expect(paths.some((p) => p.endsWith("/"))).toBe(false);
    });

    it("leaves out a skill whose name would put its files outside .claude/", () => {
      const files = buildSkillSetupFiles([
        { ...baseSkill, id: "s-1", name: "../../../../home/agent/.bashrc", prompt: "x" },
        {
          ...baseSkill,
          id: "s-2",
          name: "../../../repo/.git",
          prompt: "x",
          layout: "skill-dir",
          files: [{ relativePath: "config", content: "[core]\n\tfsmonitor = id" }],
        },
        { ...baseSkill, id: "s-3", name: "..", prompt: "x", layout: "skill-dir" },
        { ...baseSkill, id: "s-4", name: "Code Review", prompt: "ok" },
      ]);
      expect(files.map((f) => f.path)).toEqual([".claude/commands/Code Review.md"]);
    });

    it("mixes layouts in a single batch", () => {
      const files = buildSkillSetupFiles([
        { ...baseSkill, id: "s-1", name: "legacy", prompt: "old style" },
        {
          ...baseSkill,
          id: "s-2",
          name: "modern",
          prompt: "new style",
          layout: "skill-dir",
          files: [],
        },
      ]);

      expect(files.map((f) => f.path)).toEqual([
        ".claude/commands/legacy.md",
        ".claude/skills/modern/SKILL.md",
      ]);
    });
  });
});
