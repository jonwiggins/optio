import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
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
