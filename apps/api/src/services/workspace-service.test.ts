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
  workspaces: {
    id: "workspaces.id",
    slug: "workspaces.slug",
  },
  workspaceMembers: {
    id: "workspace_members.id",
    workspaceId: "workspace_members.workspace_id",
    userId: "workspace_members.user_id",
    role: "workspace_members.role",
    createdAt: "workspace_members.created_at",
  },
  users: {
    id: "users.id",
    email: "users.email",
    displayName: "users.display_name",
    avatarUrl: "users.avatar_url",
    defaultWorkspaceId: "users.default_workspace_id",
  },
}));

import { db } from "../db/client.js";
import {
  createWorkspace,
  getWorkspace,
  getWorkspaceBySlug,
  updateWorkspace,
  deleteWorkspace,
  listUserWorkspaces,
  getUserRole,
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  ensureUserHasWorkspace,
  switchWorkspace,
} from "./workspace-service.js";

describe("workspace-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createWorkspace", () => {
    it("creates workspace and adds creator as admin", async () => {
      const ws = { id: "ws-1", name: "Test", slug: "test" };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([ws]),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([ws]),
          }),
        }),
      });

      // Mock user lookup for setting default workspace
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "user-1", defaultWorkspaceId: null }]),
        }),
      });

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const result = await createWorkspace({ name: "Test", slug: "test" }, "user-1");
      expect(result).toEqual(ws);
      // Should have inserted workspace member
      expect(db.insert).toHaveBeenCalledTimes(2); // workspace + member
    });

    it("sanitizes slug to lowercase with dashes", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "ws-1", ...vals }]) };
        }),
      });

      await createWorkspace({ name: "Test", slug: "My Workspace!" });

      expect(capturedValues.slug).toBe("my-workspace-");
    });

    it("skips admin setup when no createdBy", async () => {
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "ws-1" }]),
        }),
      });

      await createWorkspace({ name: "Test", slug: "test" });

      // Only one insert (workspace), not two
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe("getWorkspace", () => {
    it("returns workspace when found", async () => {
      const ws = { id: "ws-1", name: "Test" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([ws]),
        }),
      });

      const result = await getWorkspace("ws-1");
      expect(result).toEqual(ws);
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getWorkspace("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("getWorkspaceBySlug", () => {
    it("returns workspace by slug", async () => {
      const ws = { id: "ws-1", slug: "my-ws" };
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([ws]),
        }),
      });

      const result = await getWorkspaceBySlug("my-ws");
      expect(result).toEqual(ws);
    });
  });

  describe("updateWorkspace", () => {
    it("updates workspace fields", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "ws-1", name: "Updated" }]),
            }),
          };
        }),
      });

      const result = await updateWorkspace("ws-1", { name: "Updated" });
      expect(result!.name).toBe("Updated");
      expect(capturedSet.name).toBe("Updated");
      expect(capturedSet.updatedAt).toBeInstanceOf(Date);
    });

    it("sanitizes slug on update", async () => {
      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "ws-1" }]),
            }),
          };
        }),
      });

      await updateWorkspace("ws-1", { slug: "My Slug!" });
      expect(capturedSet.slug).toBe("my-slug-");
    });

    it("returns null when workspace not found", async () => {
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await updateWorkspace("nonexistent", { name: "X" });
      expect(result).toBeNull();
    });
  });

  describe("deleteWorkspace", () => {
    it("deletes a workspace", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await deleteWorkspace("ws-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("listUserWorkspaces", () => {
    it("returns workspaces user belongs to with roles", async () => {
      const rows = [{ id: "ws-1", name: "Test", slug: "test", role: "admin" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(rows),
          }),
        }),
      });

      const result = await listUserWorkspaces("user-1");
      expect(result).toEqual(rows);
    });
  });

  describe("getUserRole", () => {
    it("returns role when user is a member", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ role: "admin" }]),
        }),
      });

      const result = await getUserRole("ws-1", "user-1");
      expect(result).toBe("admin");
    });

    it("returns null when user is not a member", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getUserRole("ws-1", "user-1");
      expect(result).toBeNull();
    });
  });

  describe("listMembers", () => {
    it("returns members with user info", async () => {
      const members = [
        { id: "m-1", userId: "u-1", role: "admin", email: "a@b.com", displayName: "User" },
      ];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(members),
          }),
        }),
      });

      const result = await listMembers("ws-1");
      expect(result).toEqual(members);
    });
  });

  describe("addMember", () => {
    it("validates user exists and adds member", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "user-1" }]),
        }),
      });

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await addMember("ws-1", "user-1", "member");
      expect(db.insert).toHaveBeenCalled();
    });

    it("throws when user not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(addMember("ws-1", "nonexistent")).rejects.toThrow("User not found");
    });
  });

  describe("updateMemberRole", () => {
    it("updates the member role", async () => {
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await updateMemberRole("ws-1", "user-1", "admin");
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe("removeMember", () => {
    it("removes a member from workspace", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await removeMember("ws-1", "user-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("ensureUserHasWorkspace", () => {
    it("returns existing default workspace", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "user-1", defaultWorkspaceId: "ws-1" }]),
        }),
      });

      const result = await ensureUserHasWorkspace("user-1");
      expect(result).toBe("ws-1");
    });

    it("sets first membership workspace as default when no default", async () => {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              // User lookup: no default workspace
              return Promise.resolve([{ id: "user-1", defaultWorkspaceId: null }]);
            }
            // listUserWorkspaces
            return Promise.resolve([]);
          }),
          innerJoin: vi.fn().mockReturnValue({
            where: vi
              .fn()
              .mockResolvedValue([
                { id: "ws-existing", name: "Existing", slug: "existing", role: "member" },
              ]),
          }),
        }),
      }));

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const result = await ensureUserHasWorkspace("user-1");
      expect(result).toBe("ws-existing");
    });
  });

  describe("switchWorkspace", () => {
    it("switches workspace when user is a member", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ role: "member" }]),
        }),
      });

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await switchWorkspace("user-1", "ws-2");
      expect(db.update).toHaveBeenCalled();
    });

    it("throws when user is not a member", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(switchWorkspace("user-1", "ws-2")).rejects.toThrow(
        "Not a member of this workspace",
      );
    });
  });
});
