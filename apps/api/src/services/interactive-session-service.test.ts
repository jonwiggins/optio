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
  interactiveSessions: {
    id: "interactive_sessions.id",
    repoUrl: "interactive_sessions.repo_url",
    state: "interactive_sessions.state",
    createdAt: "interactive_sessions.created_at",
  },
  sessionPrs: {
    id: "session_prs.id",
    sessionId: "session_prs.session_id",
    createdAt: "session_prs.created_at",
  },
  sessionChatEvents: {
    id: "session_chat_events.id",
    sessionId: "session_chat_events.session_id",
    timestamp: "session_chat_events.timestamp",
  },
  repos: {
    repoUrl: "repos.repo_url",
  },
  repoPods: {
    id: "repo_pods.id",
  },
}));

vi.mock("./event-bus.js", () => ({
  publishEvent: vi.fn(),
  publishSessionEvent: vi.fn(),
}));

vi.mock("./repo-pool-service.js", () => ({
  getOrCreateRepoPod: vi.fn(),
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

vi.mock("../routes/github-app.js", () => ({
  getCredentialSecret: vi.fn().mockReturnValue("test-secret"),
}));

import { db } from "../db/client.js";
import { publishEvent, publishSessionEvent } from "./event-bus.js";
import { getOrCreateRepoPod } from "./repo-pool-service.js";
import {
  createSession,
  getSession,
  listSessions,
  endSession,
  getSessionPrs,
  addSessionPr,
  updateSessionPr,
  getActiveSessionCount,
  appendSessionChatEvent,
  listSessionChatEvents,
} from "./interactive-session-service.js";

describe("interactive-session-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSession", () => {
    it("creates a session with repo pod", async () => {
      // Mock repo config lookup
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              defaultBranch: "main",
              imagePreset: "node",
              maxAgentsPerPod: 2,
              maxPodInstances: 1,
              networkPolicy: "unrestricted",
              cpuRequest: null,
              cpuLimit: null,
              memoryRequest: null,
              memoryLimit: null,
            },
          ]),
        }),
      });

      vi.mocked(getOrCreateRepoPod).mockResolvedValue({
        id: "pod-1",
        podName: "optio-repo-pod-1",
      } as any);

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: "session-1",
              repoUrl: "https://github.com/owner/repo",
              state: "active",
              podId: "pod-1",
            },
          ]),
        }),
      });

      const result = await createSession({
        repoUrl: "https://github.com/owner/repo",
        userId: "user-1",
      });

      expect(result.id).toBe("session-1");
      expect(result.podName).toBe("optio-repo-pod-1");
      expect(publishEvent).toHaveBeenCalled();
      expect(publishSessionEvent).toHaveBeenCalled();
    });

    it("uses default branch when no repo config", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      vi.mocked(getOrCreateRepoPod).mockResolvedValue({
        id: "pod-1",
        podName: "pod-1",
      } as any);

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue([{ id: "session-1", state: "active", podId: "pod-1" }]),
        }),
      });

      await createSession({ repoUrl: "https://github.com/o/r" });

      expect(getOrCreateRepoPod).toHaveBeenCalledWith(
        "https://github.com/o/r",
        "main",
        expect.any(Object),
        undefined,
        expect.any(Object),
      );
    });

    it("includes git credential env vars in pod env", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      vi.mocked(getOrCreateRepoPod).mockResolvedValue({
        id: "pod-1",
        podName: "pod-1",
      } as any);

      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockResolvedValue([{ id: "session-1", state: "active", podId: "pod-1" }]),
        }),
      });

      await createSession({ repoUrl: "https://github.com/o/r" });

      expect(getOrCreateRepoPod).toHaveBeenCalled();
      const callArgs = vi.mocked(getOrCreateRepoPod).mock.calls[0];
      const env = callArgs[2];

      // Verify git credential env vars are set
      expect(env.OPTIO_GIT_CREDENTIAL_URL).toBeDefined();
      expect(env.OPTIO_GIT_CREDENTIAL_URL).toContain("/api/internal/git-credentials");
      expect(env.OPTIO_CREDENTIAL_SECRET).toBe("test-secret");
    });
  });

  describe("getSession", () => {
    it("returns session with pod info", async () => {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return Promise.resolve([{ id: "session-1", state: "active", podId: "pod-1" }]);
            }
            // Pod lookup
            return Promise.resolve([{ podName: "optio-pod-1" }]);
          }),
        }),
      }));

      const result = await getSession("session-1");
      expect(result).not.toBeNull();
      expect(result!.podName).toBe("optio-pod-1");
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getSession("nonexistent");
      expect(result).toBeNull();
    });

    it("returns null podName when no pod", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "session-1", state: "active", podId: null }]),
        }),
      });

      const result = await getSession("session-1");
      expect(result!.podName).toBeNull();
    });
  });

  describe("listSessions", () => {
    it("lists sessions with default options", async () => {
      const sessions = [{ id: "s-1" }, { id: "s-2" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(sessions),
              }),
            }),
          }),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue(sessions),
            }),
          }),
        }),
      });

      const result = await listSessions();
      expect(result).toEqual(sessions);
    });

    it("filters by repoUrl and state", async () => {
      const sessions = [{ id: "s-1" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(sessions),
              }),
            }),
          }),
        }),
      });

      const result = await listSessions({
        repoUrl: "https://github.com/o/r",
        state: "active",
      });
      expect(result).toEqual(sessions);
    });
  });

  describe("endSession", () => {
    it("ends an active session", async () => {
      // getSession mock
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return Promise.resolve([{ id: "session-1", state: "active", podId: "pod-1" }]);
            }
            if (selectCallCount === 2) {
              return Promise.resolve([{ podName: "pod-1" }]);
            }
            return Promise.resolve([]);
          }),
        }),
      }));

      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "session-1", state: "ended" }]),
          }),
        }),
      });

      const result = await endSession("session-1");
      expect(result.state).toBe("ended");
      expect(publishEvent).toHaveBeenCalled();
      expect(publishSessionEvent).toHaveBeenCalled();
    });

    it("throws when session not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      await expect(endSession("nonexistent")).rejects.toThrow("Session not found");
    });

    it("throws when session already ended", async () => {
      let selectCallCount = 0;
      (db.select as any) = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) {
              return Promise.resolve([{ id: "session-1", state: "ended", podId: null }]);
            }
            return Promise.resolve([]);
          }),
        }),
      }));

      await expect(endSession("session-1")).rejects.toThrow("Session already ended");
    });
  });

  describe("getSessionPrs", () => {
    it("returns PRs for a session", async () => {
      const prs = [{ id: "pr-1", prNumber: 42 }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(prs),
          }),
        }),
      });

      const result = await getSessionPrs("session-1");
      expect(result).toEqual(prs);
    });
  });

  describe("addSessionPr", () => {
    it("adds a PR to a session", async () => {
      const pr = {
        id: "pr-1",
        sessionId: "s-1",
        prUrl: "https://github.com/o/r/pull/1",
        prNumber: 1,
      };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([pr]),
        }),
      });

      const result = await addSessionPr("s-1", "https://github.com/o/r/pull/1", 1);
      expect(result).toEqual(pr);
    });
  });

  describe("updateSessionPr", () => {
    it("updates PR fields", async () => {
      const updated = { id: "pr-1", prState: "merged" };
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updated]),
          }),
        }),
      });

      const result = await updateSessionPr("pr-1", { prState: "merged" });
      expect(result.prState).toBe("merged");
    });
  });

  describe("getActiveSessionCount", () => {
    it("returns count of active sessions", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 5 }]),
        }),
      });

      const result = await getActiveSessionCount();
      expect(result).toBe(5);
    });

    it("filters by repoUrl when provided", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 2 }]),
        }),
      });

      const result = await getActiveSessionCount("https://github.com/o/r");
      expect(result).toBe(2);
    });
  });

  describe("appendSessionChatEvent", () => {
    it("inserts an event with stream/content/logType/metadata", async () => {
      const insertReturning = vi.fn().mockResolvedValue([
        {
          id: "ev-1",
          sessionId: "s-1",
          stream: "stdout",
          content: "hi",
          logType: "text",
          metadata: { foo: "bar" },
          timestamp: new Date("2026-04-27T00:00:00Z"),
        },
      ]);
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: insertReturning }),
      });

      // Retention prune: empty cutoff lookup
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      });
      (db.delete as any) = vi.fn();

      const result = await appendSessionChatEvent({
        sessionId: "s-1",
        content: "hi",
        logType: "text",
        metadata: { foo: "bar" },
      });

      expect(result.id).toBe("ev-1");
      expect(insertReturning).toHaveBeenCalled();
    });

    it("prunes old events past the retention cap", async () => {
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: "ev-2",
              sessionId: "s-1",
              stream: "stdout",
              content: "x",
              timestamp: new Date(),
            },
          ]),
        }),
      });

      // Retention prune: cutoff lookup returns a timestamp
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([{ ts: new Date("2026-04-01T00:00:00Z") }]),
              }),
            }),
          }),
        }),
      });
      const deleteWhere = vi.fn().mockResolvedValue(undefined);
      (db.delete as any) = vi.fn().mockReturnValue({ where: deleteWhere });

      await appendSessionChatEvent({ sessionId: "s-1", content: "x" });
      expect(deleteWhere).toHaveBeenCalled();
    });

    it("does not throw if the prune step fails", async () => {
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "ev-3" }]),
        }),
      });
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockRejectedValue(new Error("prune blew up")),
              }),
            }),
          }),
        }),
      });

      const result = await appendSessionChatEvent({ sessionId: "s-1", content: "x" });
      expect(result.id).toBe("ev-3");
    });
  });

  describe("listSessionChatEvents", () => {
    it("returns events ordered by timestamp ascending", async () => {
      const events = [
        { id: "e-1", content: "first" },
        { id: "e-2", content: "second" },
      ];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(events),
            }),
          }),
        }),
      });

      const result = await listSessionChatEvents("s-1");
      expect(result).toEqual(events);
    });

    it("respects the requested limit (capped to MAX_SESSION_CHAT_EVENTS)", async () => {
      const limitFn = vi.fn().mockResolvedValue([]);
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({ limit: limitFn }),
          }),
        }),
      });

      await listSessionChatEvents("s-1", { limit: 1_000_000 });
      // The clamp should be at MAX_SESSION_CHAT_EVENTS = 5000.
      expect(limitFn).toHaveBeenCalledWith(5000);
    });
  });
});
