import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockDbExecute = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
  },
}));

import { activityRoutes } from "./activity.js";

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(activityRoutes);
}

describe("GET /api/activity", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns empty feed when no events exist", async () => {
    mockDbExecute
      .mockResolvedValueOnce([]) // items
      .mockResolvedValueOnce([{ total: 0 }]) // count
      .mockResolvedValueOnce([]); // stats

    const res = await app.inject({ method: "GET", url: "/api/activity" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.stats).toEqual({
      actions: 0,
      taskEvents: 0,
      authEvents: 0,
      infraEvents: 0,
    });
  });

  it("returns activity items with correct shape", async () => {
    const now = new Date().toISOString();
    mockDbExecute
      .mockResolvedValueOnce([
        {
          id: "a1",
          type: "action",
          timestamp: now,
          user_id: "u1",
          user_display_name: "Alice",
          user_avatar_url: "https://example.com/alice.png",
          action: "task.create",
          resource_type: "task",
          resource_id: "t1",
          summary: "task.create succeeded",
          details: { taskId: "t1" },
        },
      ])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([{ type: "action", cnt: 1 }]);

    const res = await app.inject({ method: "GET", url: "/api/activity" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].type).toBe("action");
    expect(body.items[0].actor).toEqual({
      id: "u1",
      displayName: "Alice",
      avatarUrl: "https://example.com/alice.png",
    });
    expect(body.items[0].action).toBe("task.create");
    expect(body.total).toBe(1);
    expect(body.stats.actions).toBe(1);
  });

  it("supports type filter", async () => {
    mockDbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/activity?type=task_event",
    });

    expect(res.statusCode).toBe(200);
    // When filtering by task_event, the SQL queries should be issued (3 parallel queries)
    expect(mockDbExecute).toHaveBeenCalledTimes(3);
    const body = res.json();
    expect(body.items).toEqual([]);
  });

  it("supports pagination via limit and offset", async () => {
    mockDbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/activity?limit=10&offset=20",
    });

    expect(res.statusCode).toBe(200);
  });

  it("handles system events without actors", async () => {
    const now = new Date().toISOString();
    mockDbExecute
      .mockResolvedValueOnce([
        {
          id: "ae1",
          type: "auth_event",
          timestamp: now,
          user_id: null,
          user_display_name: null,
          user_avatar_url: null,
          action: "auth:github_failed",
          resource_type: "auth",
          resource_id: null,
          summary: "github auth failed: token expired",
          details: { tokenType: "github" },
        },
      ])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([{ type: "auth_event", cnt: 1 }]);

    const res = await app.inject({ method: "GET", url: "/api/activity" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items[0].actor).toBeNull();
    expect(body.items[0].type).toBe("auth_event");
    expect(body.stats.authEvents).toBe(1);
  });

  it("returns 500 on database error", async () => {
    mockDbExecute.mockRejectedValue(new Error("connection refused"));

    const res = await app.inject({ method: "GET", url: "/api/activity" });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Failed to fetch activity feed");
  });
});

describe("GET /api/activity — workspace isolation & param whitelisting", () => {
  const dialect = new PgDialect();

  /** Compile the SQL fragment handed to the mocked db.execute into text + params. */
  function compile(call: unknown): { text: string; params: unknown[] } {
    const q = dialect.sqlToQuery(call as SQL);
    return { text: q.sql, params: q.params };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // requireRole("member") must actually enforce — never let a stray env
    // disable auth for these assertions.
    delete process.env.OPTIO_AUTH_DISABLED;
  });

  it("scopes a member strictly to their own workspace (no null-workspace rows)", async () => {
    mockDbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const app = await buildRouteTestApp((await import("./activity.js")).activityRoutes, {
      user: { id: "u-A", workspaceId: "ws-A", workspaceRole: "member" },
    });
    const res = await app.inject({ method: "GET", url: "/api/activity?type=action" });
    expect(res.statusCode).toBe(200);

    const { text, params } = compile(mockDbExecute.mock.calls[0][0]);
    // Query is scoped by workspace_id and bound to the caller's workspace only.
    expect(text).toContain("workspace_id");
    expect(params).toContain("ws-A");
    // Members get strict equality — NOT the admin `OR workspace_id IS NULL` branch.
    expect(text.toLowerCase()).not.toContain("is null");
  });

  it("lets an admin additionally see legacy null-workspace rows", async () => {
    mockDbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const app = await buildRouteTestApp((await import("./activity.js")).activityRoutes, {
      user: { id: "u-A", workspaceId: "ws-A", workspaceRole: "admin" },
    });
    const res = await app.inject({ method: "GET", url: "/api/activity?type=action" });
    expect(res.statusCode).toBe(200);

    const { text, params } = compile(mockDbExecute.mock.calls[0][0]);
    expect(params).toContain("ws-A");
    // Admins see own-workspace + operator/legacy (null) rows.
    expect(text.toLowerCase()).toContain("workspace_id is null");
  });

  it("does not leak another workspace's data: bound workspace is the caller's", async () => {
    mockDbExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const app = await buildRouteTestApp((await import("./activity.js")).activityRoutes, {
      user: { id: "u-A", workspaceId: "ws-A", workspaceRole: "member" },
    });
    await app.inject({ method: "GET", url: "/api/activity?type=action" });

    const { params } = compile(mockDbExecute.mock.calls[0][0]);
    // The only workspace ever bound is the caller's — workspace B is unreachable.
    expect(params).toContain("ws-A");
    expect(params).not.toContain("ws-B");
  });

  it("strips secret-bearing params from the response, keeping only allowlisted keys", async () => {
    const now = new Date().toISOString();
    mockDbExecute
      .mockResolvedValueOnce([
        {
          id: "a1",
          type: "action",
          timestamp: now,
          user_id: "u-A",
          user_display_name: "Alice",
          user_avatar_url: null,
          action: "connection.update",
          resource_type: "connection",
          resource_id: "c1",
          summary: "connection.update succeeded",
          // Legacy row written before write-time filtering: full jsonb with secrets.
          details: {
            connectionId: "c1",
            name: "prod-db",
            apiToken: "SHOULD_NOT_LEAK",
            password: "hunter2",
            config: { url: "postgres://user:hunter2@db/app" },
            crossTenantResourceId: "ws-B-secret-id",
          },
        },
      ])
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([{ type: "action", cnt: 1 }]);

    const app = await buildRouteTestApp((await import("./activity.js")).activityRoutes, {
      user: { id: "u-A", workspaceId: "ws-A", workspaceRole: "admin" },
    });
    const res = await app.inject({ method: "GET", url: "/api/activity" });
    expect(res.statusCode).toBe(200);

    const details = res.json().items[0].details;
    expect(details).toEqual({ connectionId: "c1", name: "prod-db" });
    // The whole serialized response must not carry the secret values.
    const raw = res.payload;
    expect(raw).not.toContain("SHOULD_NOT_LEAK");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("crossTenantResourceId");
  });

  it("forbids viewers (read-only) from reading the audit feed", async () => {
    const app = await buildRouteTestApp((await import("./activity.js")).activityRoutes, {
      user: { id: "u-v", workspaceId: "ws-A", workspaceRole: "viewer" },
    });
    const res = await app.inject({ method: "GET", url: "/api/activity" });
    expect(res.statusCode).toBe(403);
    // Never touched the database.
    expect(mockDbExecute).not.toHaveBeenCalled();
  });
});
