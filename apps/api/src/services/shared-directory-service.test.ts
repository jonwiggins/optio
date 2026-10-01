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
  repoSharedDirectories: {
    id: "repo_shared_directories.id",
    repoId: "repo_shared_directories.repo_id",
    workspaceId: "repo_shared_directories.workspace_id",
    name: "repo_shared_directories.name",
    sizeGi: "repo_shared_directories.size_gi",
    scope: "repo_shared_directories.scope",
    mountLocation: "repo_shared_directories.mount_location",
    mountSubPath: "repo_shared_directories.mount_sub_path",
    createdAt: "repo_shared_directories.created_at",
  },
  repos: {
    id: "repos.id",
    repoUrl: "repos.repo_url",
  },
  agentPods: {
    id: "agent_pods.id",
    pool: "agent_pods.pool",
    poolKey: "agent_pods.pool_key",
    state: "agent_pods.state",
    cachePvcName: "agent_pods.cache_pvc_name",
    cachePvcState: "agent_pods.cache_pvc_state",
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
  listSharedDirectories,
  createSharedDirectory,
  deleteSharedDirectory,
  getSharedDirectory,
  updateSharedDirectory,
  getMountPath,
  validateSharedDirectoryInput,
} from "./shared-directory-service.js";

describe("shared-directory-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listSharedDirectories", () => {
    it("lists all shared directories for a repo", async () => {
      const dirs = [
        {
          id: "sd-1",
          repoId: "r-1",
          name: "npm-cache",
          mountLocation: "home",
          mountSubPath: ".npm",
          sizeGi: 10,
        },
      ];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(dirs),
        }),
      });

      const result = await listSharedDirectories("r-1");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("npm-cache");
    });

    it("returns empty array when no directories exist", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await listSharedDirectories("r-1");
      expect(result).toHaveLength(0);
    });
  });

  describe("getSharedDirectory", () => {
    it("returns directory when found", async () => {
      const dir = { id: "sd-1", name: "npm-cache" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([dir]),
        }),
      });

      const result = await getSharedDirectory("sd-1");
      expect(result).toMatchObject(dir);
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getSharedDirectory("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createSharedDirectory", () => {
    it("creates a shared directory", async () => {
      const input = {
        repoId: "r-1",
        name: "npm-cache",
        mountLocation: "home" as const,
        mountSubPath: ".npm",
        sizeGi: 10,
      };
      const created = { id: "sd-1", ...input, scope: "per-pod" };

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([created]),
        }),
      });

      const result = await createSharedDirectory(input);
      expect(result).toMatchObject({ id: "sd-1", name: "npm-cache" });
    });

    it("validates total size cap", async () => {
      // Existing dirs take up 195Gi total
      const existingDirs = [
        { id: "sd-1", repoId: "r-1", sizeGi: 100 },
        { id: "sd-2", repoId: "r-1", sizeGi: 95 },
      ];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(existingDirs),
        }),
      });

      await expect(
        createSharedDirectory({
          repoId: "r-1",
          name: "big-cache",
          mountLocation: "home",
          mountSubPath: ".big",
          sizeGi: 10,
        }),
      ).rejects.toThrow("total cache size");
    });
  });

  describe("deleteSharedDirectory", () => {
    it("deletes a shared directory", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await deleteSharedDirectory("sd-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("updateSharedDirectory", () => {
    it("updates directory fields", async () => {
      const updated = { id: "sd-1", description: "Updated description" };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await updateSharedDirectory("sd-1", {
        description: "Updated description",
      });
      expect(result).toMatchObject({ description: "Updated description" });
    });

    it("returns null when not found", async () => {
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await updateSharedDirectory("nonexistent", {
        description: "test",
      });
      expect(result).toBeNull();
    });
  });

  describe("getMountPath", () => {
    it("generates workspace mount path", () => {
      expect(getMountPath("workspace", ".optio-cache/node-modules")).toBe(
        "/workspace/.optio-cache/node-modules",
      );
    });

    it("generates home mount path", () => {
      expect(getMountPath("home", ".npm")).toBe("/home/agent/.npm");
    });

    it("handles nested home paths", () => {
      expect(getMountPath("home", ".cache/huggingface")).toBe("/home/agent/.cache/huggingface");
    });
  });

  describe("validateSharedDirectoryInput", () => {
    it("accepts valid input", () => {
      const result = validateSharedDirectoryInput({
        name: "npm-cache",
        mountLocation: "home",
        mountSubPath: ".npm",
        sizeGi: 10,
      });
      expect(result).toBeNull();
    });

    it("rejects invalid name format", () => {
      const result = validateSharedDirectoryInput({
        name: "INVALID_NAME!",
        mountLocation: "home",
        mountSubPath: ".npm",
        sizeGi: 10,
      });
      expect(result).toContain("name");
    });

    it("rejects path traversal in mountSubPath", () => {
      const result = validateSharedDirectoryInput({
        name: "sneaky",
        mountLocation: "home",
        mountSubPath: "../etc/passwd",
        sizeGi: 10,
      });
      expect(result).toContain("path traversal");
    });

    it("rejects absolute mountSubPath", () => {
      const result = validateSharedDirectoryInput({
        name: "sneaky",
        mountLocation: "home",
        mountSubPath: "/etc/passwd",
        sizeGi: 10,
      });
      expect(result).toContain("must not start with /");
    });

    it("rejects size over max", () => {
      const result = validateSharedDirectoryInput({
        name: "big",
        mountLocation: "home",
        mountSubPath: ".big",
        sizeGi: 200,
      });
      expect(result).toContain("100");
    });

    it("rejects size under 1", () => {
      const result = validateSharedDirectoryInput({
        name: "tiny",
        mountLocation: "home",
        mountSubPath: ".tiny",
        sizeGi: 0,
      });
      expect(result).toContain("1");
    });

    it("rejects per-repo scope in v1", () => {
      const result = validateSharedDirectoryInput({
        name: "cache",
        mountLocation: "home",
        mountSubPath: ".cache",
        sizeGi: 10,
        scope: "per-repo",
      });
      expect(result).toContain("per-pod");
    });

    it("rejects invalid mount location", () => {
      const result = validateSharedDirectoryInput({
        name: "cache",
        mountLocation: "invalid" as any,
        mountSubPath: ".cache",
        sizeGi: 10,
      });
      expect(result).toContain("mount location");
    });
  });
});
