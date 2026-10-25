import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { mockTask } from "../test-utils/fixtures.js";

// ─── Mocks ───

const mockGetSubtasks = vi.fn();
const mockCreateSubtask = vi.fn();
const mockQueueSubtask = vi.fn();
const mockCheckBlockingSubtasks = vi.fn();

vi.mock("../services/subtask-service.js", () => ({
  getSubtasks: (...args: unknown[]) => mockGetSubtasks(...args),
  createSubtask: (...args: unknown[]) => mockCreateSubtask(...args),
  queueSubtask: (...args: unknown[]) => mockQueueSubtask(...args),
  checkBlockingSubtasks: (...args: unknown[]) => mockCheckBlockingSubtasks(...args),
}));

const mockGetTask = vi.fn();
vi.mock("../services/task-service.js", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
}));

import { subtaskRoutes } from "./subtasks.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(subtaskRoutes);
}

const mockTaskData = { ...mockTask };
const mockSubtaskData = { ...mockTask, id: "sub-1", parentTaskId: "task-1" };

describe("GET /api/tasks/:id/subtasks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists subtasks for a task", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockGetSubtasks.mockResolvedValue([{ ...mockSubtaskData, title: "Step 1" }]);

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/subtasks" });

    expect(res.statusCode).toBe(200);
    expect(res.json().subtasks).toHaveLength(1);
  });

  it("returns 404 if parent task not found", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/tasks/nonexistent/subtasks" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 if task is in a different workspace", async () => {
    mockGetTask.mockResolvedValue({ ...mockTaskData, workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/subtasks" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tasks/:id/subtasks", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates and auto-queues a child subtask", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCreateSubtask.mockResolvedValue({
      ...mockSubtaskData,
      title: "Child task",
      subtaskOrder: 0,
    });
    mockQueueSubtask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Child task", prompt: "Do the thing", taskType: "child" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().subtask.id).toBe("sub-1");
    expect(mockQueueSubtask).toHaveBeenCalledWith("sub-1");
  });

  it("auto-queues first step but not subsequent steps", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCreateSubtask.mockResolvedValue({
      ...mockSubtaskData,
      id: "sub-2",
      title: "Step 2",
      subtaskOrder: 1,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Step 2", prompt: "Do step 2", taskType: "step" },
    });

    expect(res.statusCode).toBe(201);
    // subtaskOrder 1 means not the first step, so should NOT auto-queue
    expect(mockQueueSubtask).not.toHaveBeenCalled();
  });

  it("respects autoQueue=false", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCreateSubtask.mockResolvedValue({
      ...mockSubtaskData,
      title: "Manual task",
      subtaskOrder: 0,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Manual task", prompt: "Wait for me", autoQueue: false },
    });

    expect(res.statusCode).toBe(201);
    expect(mockQueueSubtask).not.toHaveBeenCalled();
  });

  it("rejects missing title (400 from Zod body schema)", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/subtasks",
      payload: { prompt: "Do something" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/tasks/:id/subtasks/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns blocking subtask status", async () => {
    mockGetTask.mockResolvedValue(mockTaskData);
    mockCheckBlockingSubtasks.mockResolvedValue({
      allComplete: false,
      total: 3,
      pending: 0,
      running: 2,
      completed: 1,
      failed: 0,
    });

    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/subtasks/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().allComplete).toBe(false);
    expect(res.json().total).toBe(3);
  });
});

// ─── Work the person may not see (services/work-visibility.ts) ───

describe("someone else's private task", () => {
  /** A workspace member (not an admin); no workspace, so only visibility decides. */
  const member = (over: Record<string, unknown> = {}) => ({
    id: "user-2",
    workspaceId: null,
    workspaceRole: "member" as const,
    teamIds: [] as string[],
    ...over,
  });
  const othersPrivate = {
    id: "task-1",
    workspaceId: null,
    ownerUserId: "user-1",
    ownerTeamId: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const requests = [
    { method: "GET" as const, url: "/api/tasks/task-1/subtasks" },
    {
      method: "POST" as const,
      url: "/api/tasks/task-1/subtasks",
      payload: { title: "Child task", prompt: "Do the thing", taskType: "child" },
    },
    { method: "GET" as const, url: "/api/tasks/task-1/subtasks/status" },
  ];

  it.each(requests)("$method $url is a 404", async (request) => {
    mockGetTask.mockResolvedValue(othersPrivate);
    const app = await buildRouteTestApp(subtaskRoutes, { user: member() });
    const res = await app.inject(request);
    expect(res.statusCode).toBe(404);
    expect(mockGetSubtasks).not.toHaveBeenCalled();
    expect(mockCreateSubtask).not.toHaveBeenCalled();
    expect(mockCheckBlockingSubtasks).not.toHaveBeenCalled();
  });

  it("lists only the subtasks the person may see", async () => {
    mockGetTask.mockResolvedValue({ ...mockTaskData, ownerUserId: null, ownerTeamId: null });
    mockGetSubtasks.mockResolvedValue([
      { ...mockSubtaskData, id: "sub-mine", ownerUserId: "user-2" },
      { ...mockSubtaskData, id: "sub-theirs", ownerUserId: "user-1", ownerTeamId: null },
    ]);
    const app = await buildRouteTestApp(subtaskRoutes, { user: member() });
    const res = await app.inject({ method: "GET", url: "/api/tasks/task-1/subtasks" });
    expect(res.statusCode).toBe(200);
    expect(res.json().subtasks.map((t: { id: string }) => t.id)).toEqual(["sub-mine"]);
  });
});
