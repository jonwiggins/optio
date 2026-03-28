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
  repos: {
    id: "repos.id",
    repoUrl: "repos.repo_url",
    workspaceId: "repos.workspace_id",
  },
  workspaces: {
    id: "workspaces.id",
    slug: "workspaces.slug",
  },
}));

import { db } from "../db/client.js";
import {
  listRepos,
  getRepo,
  getRepoByUrl,
  createRepo,
  updateRepo,
  deleteRepo,
} from "./repo-service.js";

describe("repo-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listRepos", () => {
    it("lists all repos without filter", async () => {
      const repos = [{ id: "r-1", repoUrl: "https://github.com/o/r" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue(repos),
      });

      const result = await listRepos();
      expect(result).toEqual(repos);
    });

    it("filters by workspaceId", async () => {
      const repos = [{ id: "r-1" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(repos),
        }),
      });

      const result = await listRepos("ws-1");
      expect(result).toEqual(repos);
    });
  });

  describe("getRepo", () => {
    it("returns repo when found", async () => {
      const repo = { id: "r-1", repoUrl: "https://github.com/o/r" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([repo]),
        }),
      });

      const result = await getRepo("r-1");
      expect(result).toEqual(repo);
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getRepo("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getRepoByUrl", () => {
    it("finds repo by normalized URL with workspaceId", async () => {
      const repo = { id: "r-1", repoUrl: "https://github.com/o/r" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([repo]),
        }),
      });

      const result = await getRepoByUrl("https://github.com/o/r.git", "ws-1");
      expect(result).toEqual(repo);
    });

    it("returns null when not found", async () => {
      // Default workspace lookup
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              // getDefaultWorkspaceId
              return Promise.resolve([]);
            }
            // isNull fallback
            return Promise.resolve([]);
          }),
        }),
      }));

      const result = await getRepoByUrl("https://github.com/o/nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createRepo", () => {
    it("creates a repo with normalized URL", async () => {
      let capturedValues: any;
      // getDefaultWorkspaceId
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "default-ws" }]),
        }),
      });

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return {
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "r-1", ...vals }]),
            }),
          };
        }),
      });

      const result = await createRepo({
        repoUrl: "https://github.com/Owner/Repo.git",
        fullName: "Owner/Repo",
      });

      expect(capturedValues.repoUrl).toBe("https://github.com/owner/repo");
      expect(capturedValues.defaultBranch).toBe("main");
    });

    it("uses provided workspaceId", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return {
            onConflictDoUpdate: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "r-1" }]),
            }),
          };
        }),
      });

      await createRepo({
        repoUrl: "https://github.com/o/r",
        fullName: "o/r",
        workspaceId: "ws-custom",
      });

      expect(capturedValues.workspaceId).toBe("ws-custom");
    });
  });

  describe("updateRepo", () => {
    it("updates repo fields", async () => {
      const updated = { id: "r-1", autoMerge: true };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await updateRepo("r-1", { autoMerge: true });
      expect(result!.autoMerge).toBe(true);
    });

    it("returns null when repo not found", async () => {
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await updateRepo("nonexistent", { autoMerge: true });
      expect(result).toBeNull();
    });
  });

  describe("deleteRepo", () => {
    it("deletes a repo", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await deleteRepo("r-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });
});
