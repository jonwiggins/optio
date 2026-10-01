import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WorkRow } from "@optio/shared";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockListWork = vi.fn();
const mockResolveWork = vi.fn();
vi.mock("../services/work-service.js", () => ({
  listWork: (...args: unknown[]) => mockListWork(...args),
  resolveWork: (...args: unknown[]) => mockResolveWork(...args),
}));

import { workRoutes } from "./work.js";

const row = (over: Partial<WorkRow>): WorkRow => ({
  key: "task-t1",
  source: "repo-task",
  id: "t1",
  href: "/tasks/t1",
  name: "Fix it",
  when: "now",
  where: { target: "pod", detail: "acme/app" },
  who: "claude-code",
  then: "exits",
  status: "running",
  statusLabel: "running",
  note: null,
  prUrl: null,
  lastActivity: "2026-09-01T00:00:00.000Z",
  recurring: false,
  editHref: null,
  spawned: false,
  ...over,
});

describe("GET /api/work", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(workRoutes);
  });

  it("lists work in the caller's scope", async () => {
    mockListWork.mockResolvedValue([row({})]);
    const res = await app.inject({ method: "GET", url: "/api/work" });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([row({})]);
    expect(mockListWork).toHaveBeenCalledWith({ workspaceId: "ws-1", userId: "user-1" });
  });

  it("filters to one view", async () => {
    mockListWork.mockResolvedValue([
      row({}),
      row({ key: "job-j1", source: "standalone", recurring: true, status: "scheduled" }),
      row({ key: "task-t2", status: "done" }),
    ]);
    const res = await app.inject({ method: "GET", url: "/api/work?view=recurring" });
    expect(res.json().rows.map((r: WorkRow) => r.key)).toEqual(["job-j1"]);
  });

  it("rejects an unknown view", async () => {
    const res = await app.inject({ method: "GET", url: "/api/work?view=nope" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/work/:id", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(workRoutes);
  });

  it("returns the resolved work", async () => {
    mockResolveWork.mockResolvedValue({
      source: "repo-task",
      data: { id: "t1", title: "Fix it" },
      row: row({}),
    });
    const res = await app.inject({ method: "GET", url: "/api/work/t1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      source: "repo-task",
      work: { id: "t1" },
      row: { key: "task-t1" },
    });
    expect(mockResolveWork).toHaveBeenCalledWith("t1", { workspaceId: "ws-1", userId: "user-1" });
  });

  it("404s when nothing in scope has the id", async () => {
    mockResolveWork.mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/api/work/nope" });
    expect(res.statusCode).toBe(404);
  });
});
