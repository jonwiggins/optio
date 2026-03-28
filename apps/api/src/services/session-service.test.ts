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
  users: {
    id: "users.id",
    provider: "users.provider",
    externalId: "users.external_id",
    email: "users.email",
    displayName: "users.display_name",
    avatarUrl: "users.avatar_url",
    defaultWorkspaceId: "users.default_workspace_id",
  },
  sessions: {
    id: "sessions.id",
    userId: "sessions.user_id",
    tokenHash: "sessions.token_hash",
    expiresAt: "sessions.expires_at",
    createdAt: "sessions.created_at",
  },
}));

import { db } from "../db/client.js";
import {
  createSession,
  validateSession,
  revokeSession,
  revokeAllUserSessions,
  createWsToken,
  cleanupExpiredSessions,
} from "./session-service.js";

describe("session-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSession", () => {
    it("creates new user and session when user not found", async () => {
      // User lookup returns empty
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      // Insert user
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: "user-1",
              provider: "github",
              externalId: "ext-1",
              email: "test@test.com",
              displayName: "Test User",
              avatarUrl: null,
              defaultWorkspaceId: null,
            },
          ]),
        }),
      });

      const result = await createSession("github", {
        externalId: "ext-1",
        email: "test@test.com",
        displayName: "Test User",
      });

      expect(result.user.email).toBe("test@test.com");
      expect(result.user.provider).toBe("github");
      expect(result.token).toBeDefined();
      expect(result.token.length).toBe(64); // 32 bytes hex
    });

    it("updates existing user on login", async () => {
      // User lookup returns existing
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: "user-1",
                provider: "github",
                externalId: "ext-1",
                email: "old@test.com",
                displayName: "Old Name",
              },
            ]),
          }),
        }),
      });

      // Update user
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: "user-1",
                provider: "github",
                externalId: "ext-1",
                email: "new@test.com",
                displayName: "New Name",
                avatarUrl: null,
                defaultWorkspaceId: "ws-1",
              },
            ]),
          }),
        }),
      });

      // Insert session
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      const result = await createSession("github", {
        externalId: "ext-1",
        email: "new@test.com",
        displayName: "New Name",
      });

      expect(result.user.email).toBe("new@test.com");
      expect(result.user.workspaceId).toBe("ws-1");
    });
  });

  describe("validateSession", () => {
    it("returns user for valid session", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  sessionId: "sess-1",
                  userId: "user-1",
                  provider: "github",
                  email: "test@test.com",
                  displayName: "Test",
                  avatarUrl: null,
                  defaultWorkspaceId: "ws-1",
                },
              ]),
            }),
          }),
        }),
      });

      const result = await validateSession("some-token");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("user-1");
      expect(result!.email).toBe("test@test.com");
    });

    it("returns null for invalid or expired session", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const result = await validateSession("bad-token");
      expect(result).toBeNull();
    });
  });

  describe("revokeSession", () => {
    it("deletes session by token hash", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await revokeSession("some-token");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("revokeAllUserSessions", () => {
    it("deletes all sessions for a user", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      await revokeAllUserSessions("user-1");
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe("createWsToken", () => {
    it("creates a short-lived WebSocket token", async () => {
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      const token = await createWsToken("user-1");
      expect(token).toBeDefined();
      expect(token.length).toBe(64); // 32 bytes hex
    });
  });

  describe("cleanupExpiredSessions", () => {
    it("deletes expired sessions and returns count", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "s-1" }, { id: "s-2" }]),
        }),
      });

      const count = await cleanupExpiredSessions();
      expect(count).toBe(2);
    });

    it("returns 0 when no expired sessions", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const count = await cleanupExpiredSessions();
      expect(count).toBe(0);
    });
  });
});
