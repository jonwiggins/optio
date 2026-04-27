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
  installedSkills: {
    id: "installed_skills.id",
    scope: "installed_skills.scope",
    workspaceId: "installed_skills.workspace_id",
    enabled: "installed_skills.enabled",
    resolvedSha: "installed_skills.resolved_sha",
    agentTypes: "installed_skills.agent_types",
  },
}));

import { db } from "../db/client.js";
import {
  createInstalledSkill,
  getInstalledSkillsForTask,
  recordSyncResult,
  updateInstalledSkill,
} from "./installed-skill-service.js";

const baseRow = {
  id: "skill-1",
  name: "superpowers",
  description: null,
  sourceType: "git",
  sourceUrl: "https://github.com/example/skills.git",
  ref: "main",
  resolvedSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  subpath: ".",
  scope: "global",
  repoUrl: null,
  workspaceId: null,
  agentTypes: null,
  enabled: true,
  lastSyncedAt: new Date(),
  lastSyncError: null,
  cachedManifest: null,
  hasExecutableFiles: false,
  totalSizeBytes: 100,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const makeRow = (overrides: Record<string, unknown> = {}) => ({ ...baseRow, ...overrides });

describe("installed-skill-service", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("createInstalledSkill", () => {
    it("normalizes empty subpath to '.'", async () => {
      let captured: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          captured = vals;
          return { returning: vi.fn().mockResolvedValue([makeRow()]) };
        }),
      });

      await createInstalledSkill({
        name: "x",
        sourceUrl: "https://example.com/x.git",
        subpath: "",
      });
      expect(captured.subpath).toBe(".");
    });

    it("rejects subpaths with .. segments", async () => {
      await expect(
        createInstalledSkill({
          name: "x",
          sourceUrl: "https://example.com/x.git",
          subpath: "foo/../bar",
        }),
      ).rejects.toThrow(/invalid subpath/);
    });

    it("strips leading slashes from subpath", async () => {
      let captured: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          captured = vals;
          return { returning: vi.fn().mockResolvedValue([makeRow()]) };
        }),
      });

      await createInstalledSkill({
        name: "x",
        sourceUrl: "https://example.com/x.git",
        subpath: "/skills/superpowers",
      });
      expect(captured.subpath).toBe("skills/superpowers");
    });

    it("defaults ref to 'main' when omitted or blank", async () => {
      let captured: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          captured = vals;
          return { returning: vi.fn().mockResolvedValue([makeRow()]) };
        }),
      });

      await createInstalledSkill({
        name: "x",
        sourceUrl: "https://example.com/x.git",
        ref: "  ",
      });
      expect(captured.ref).toBe("main");
    });
  });

  describe("updateInstalledSkill", () => {
    it("clears resolvedSha when ref changes", async () => {
      let captured: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          captured = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([makeRow({ resolvedSha: null })]),
            }),
          };
        }),
      });

      await updateInstalledSkill("skill-1", { ref: "v2.0.0" });
      expect(captured.ref).toBe("v2.0.0");
      expect(captured.resolvedSha).toBeNull();
      expect(captured.lastSyncError).toBeNull();
    });

    it("does not clear resolvedSha when only enabled changes", async () => {
      let captured: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          captured = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([makeRow()]),
            }),
          };
        }),
      });

      await updateInstalledSkill("skill-1", { enabled: false });
      expect(captured.enabled).toBe(false);
      expect(captured.resolvedSha).toBeUndefined();
    });
  });

  describe("recordSyncResult", () => {
    it("writes manifest, sha, and clears error on success", async () => {
      let captured: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          captured = vals;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      });

      await recordSyncResult("skill-1", {
        ok: true,
        resolvedSha: "abc",
        manifest: { files: [{ relativePath: "SKILL.md", sizeBytes: 10, executable: false }] },
        hasExecutableFiles: false,
        totalSizeBytes: 10,
      });
      expect(captured.resolvedSha).toBe("abc");
      expect(captured.lastSyncError).toBeNull();
      expect(captured.cachedManifest.files).toHaveLength(1);
    });

    it("writes error message and leaves resolvedSha alone on failure", async () => {
      let captured: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          captured = vals;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      });

      await recordSyncResult("skill-1", { ok: false, error: "clone failed" });
      expect(captured.lastSyncError).toBe("clone failed");
      expect(captured.resolvedSha).toBeUndefined();
    });
  });

  describe("getInstalledSkillsForTask", () => {
    it("excludes rows with no resolvedSha (never synced)", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              makeRow({ id: "s-1", name: "ok", resolvedSha: "abc" }),
              makeRow({ id: "s-2", name: "pending", resolvedSha: null }),
            ]),
        }),
      });

      const result = await getInstalledSkillsForTask("https://example.com/r");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("ok");
    });

    it("filters by agent type when set", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              makeRow({ id: "s-1", name: "claude-only", agentTypes: ["claude-code"] }),
              makeRow({ id: "s-2", name: "codex-only", agentTypes: ["codex"] }),
              makeRow({ id: "s-3", name: "any", agentTypes: null }),
            ]),
        }),
      });

      const result = await getInstalledSkillsForTask("https://example.com/r", null, "claude-code");
      const names = result.map((s) => s.name).sort();
      expect(names).toEqual(["any", "claude-only"]);
    });

    it("repo-scoped row overrides global with same name", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            makeRow({
              id: "s-g",
              name: "shared",
              scope: "global",
              resolvedSha: "g".repeat(40),
            }),
            makeRow({
              id: "s-r",
              name: "shared",
              scope: "https://example.com/r",
              resolvedSha: "r".repeat(40),
            }),
          ]),
        }),
      });

      const result = await getInstalledSkillsForTask("https://example.com/r");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("s-r");
    });
  });
});
