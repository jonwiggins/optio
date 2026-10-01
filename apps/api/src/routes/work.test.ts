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

const { WorkError } = vi.hoisted(() => ({
  WorkError: class WorkError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly details?: string,
    ) {
      super(message);
    }
  },
}));
const mockCreateWork = vi.fn();
const mockUpdateWork = vi.fn();
const mockDeleteWork = vi.fn();
const mockGetOwnDefinition = vi.fn();
const mockAssertMayChange = vi.fn();
vi.mock("../services/work-write-service.js", () => ({
  WorkError,
  createWork: (...args: unknown[]) => mockCreateWork(...args),
  updateWork: (...args: unknown[]) => mockUpdateWork(...args),
  deleteWork: (...args: unknown[]) => mockDeleteWork(...args),
  getOwnDefinition: (...args: unknown[]) => mockGetOwnDefinition(...args),
  assertMayChange: (...args: unknown[]) => mockAssertMayChange(...args),
}));
const mockCreateTrigger = vi.fn();
vi.mock("../services/trigger-service.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/trigger-service.js")>()),
  createTrigger: (...args: unknown[]) => mockCreateTrigger(...args),
  listTriggers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../services/optio-action-service.js", () => ({
  logAction: vi.fn().mockResolvedValue(undefined),
}));

import { workRoutes } from "./work.js";

const spec = {
  name: "Nightly",
  when: { type: "schedule", config: { cronExpression: "0 9 * * *" } },
  where: { runTarget: "cluster" },
  who: { runtime: "claude-code" },
  what: { prompt: "go" },
  then: "exits",
};

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

describe("writing work", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(workRoutes);
  });

  it("creates from the attributes as the caller, answering 201 with what was made", async () => {
    mockCreateWork.mockResolvedValue({ kind: "standalone", id: "j1", href: "/jobs/j1" });
    const res = await app.inject({ method: "POST", url: "/api/work", payload: spec });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ kind: "standalone", id: "j1", href: "/jobs/j1" });
    expect(mockCreateWork).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Nightly" }),
      expect.objectContaining({ workspaceId: "ws-1", userId: "user-1" }),
    );
  });

  it("turns a WorkError into its status, saying what was taken", async () => {
    mockCreateWork.mockRejectedValue(
      new WorkError(409, 'A Job named "Nightly" already exists', "name_taken"),
    );
    const res = await app.inject({ method: "POST", url: "/api/work", payload: spec });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'A Job named "Nightly" already exists',
      details: "name_taken",
    });
  });

  it("refuses a body that isn't the five attributes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/work",
      payload: { ...spec, then: "sometimes" },
    });
    expect(res.statusCode).toBe(400);
    expect(mockCreateWork).not.toHaveBeenCalled();
  });

  it("saves a definition and deletes one, 404 when it isn't there", async () => {
    mockUpdateWork.mockResolvedValue({ kind: "standalone", id: "j1", href: "/jobs/j1" });
    const saved = await app.inject({ method: "PATCH", url: "/api/work/j1", payload: spec });
    expect(saved.statusCode).toBe(200);
    expect(mockUpdateWork.mock.calls[0][0]).toBe("j1");

    mockDeleteWork.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await app.inject({ method: "DELETE", url: "/api/work/j1" })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: "/api/work/j1" })).statusCode).toBe(404);
  });

  it("only lets the owner of personal work change its triggers", async () => {
    mockGetOwnDefinition.mockResolvedValue({ id: "j1", kind: "standalone", ownerUserId: "u2" });
    mockAssertMayChange.mockRejectedValue(new WorkError(403, "Only Bo can change this"));
    const res = await app.inject({
      method: "POST",
      url: "/api/work/j1/triggers",
      payload: { type: "manual", config: {} },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("Only Bo can change this");
    expect(mockCreateTrigger).not.toHaveBeenCalled();
  });
});
