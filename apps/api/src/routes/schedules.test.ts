import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListSchedules = vi.fn();
const mockGetSchedule = vi.fn();
const mockCreateSchedule = vi.fn();
const mockUpdateSchedule = vi.fn();
const mockDeleteSchedule = vi.fn();
const mockRecordRun = vi.fn();
const mockGetScheduleRuns = vi.fn();
const mockValidateCronExpression = vi.fn();

vi.mock("../services/schedule-service.js", () => ({
  listSchedules: (...args: unknown[]) => mockListSchedules(...args),
  getSchedule: (...args: unknown[]) => mockGetSchedule(...args),
  createSchedule: (...args: unknown[]) => mockCreateSchedule(...args),
  updateSchedule: (...args: unknown[]) => mockUpdateSchedule(...args),
  deleteSchedule: (...args: unknown[]) => mockDeleteSchedule(...args),
  recordRun: (...args: unknown[]) => mockRecordRun(...args),
  getScheduleRuns: (...args: unknown[]) => mockGetScheduleRuns(...args),
  validateCronExpression: (...args: unknown[]) => mockValidateCronExpression(...args),
}));

const mockCreateTask = vi.fn();
const mockTransitionTask = vi.fn();
vi.mock("../services/task-service.js", () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

import { scheduleRoutes } from "./schedules.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest("user", undefined as any);
  app.addHook("preHandler", (req, _reply, done) => {
    (req as any).user = { id: "user-1", workspaceId: "ws-1" };
    done();
  });
  await scheduleRoutes(app);
  await app.ready();
  return app;
}

const mockScheduleData = {
  id: "sched-1",
  name: "Nightly build",
  cronExpression: "0 0 * * *",
  taskConfig: {
    title: "Build",
    prompt: "Run build",
    repoUrl: "https://github.com/org/repo",
    agentType: "claude-code",
  },
};

describe("GET /api/schedules", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists schedules", async () => {
    mockListSchedules.mockResolvedValue([mockScheduleData]);

    const res = await app.inject({ method: "GET", url: "/api/schedules" });

    expect(res.statusCode).toBe(200);
    expect(res.json().schedules).toHaveLength(1);
  });
});

describe("POST /api/schedules", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a schedule with valid cron", async () => {
    mockValidateCronExpression.mockReturnValue({ valid: true });
    mockCreateSchedule.mockResolvedValue(mockScheduleData);

    const res = await app.inject({
      method: "POST",
      url: "/api/schedules",
      payload: {
        name: "Nightly build",
        cronExpression: "0 0 * * *",
        taskConfig: {
          title: "Build",
          prompt: "Run build",
          repoUrl: "https://github.com/org/repo",
          agentType: "claude-code",
        },
      },
    });

    expect(res.statusCode).toBe(201);
  });

  it("rejects invalid cron expression", async () => {
    mockValidateCronExpression.mockReturnValue({ valid: false, error: "bad expression" });

    const res = await app.inject({
      method: "POST",
      url: "/api/schedules",
      payload: {
        name: "Bad schedule",
        cronExpression: "invalid",
        taskConfig: {
          title: "Build",
          prompt: "Run build",
          repoUrl: "https://github.com/org/repo",
          agentType: "claude-code",
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid cron expression");
  });
});

describe("PATCH /api/schedules/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a schedule", async () => {
    mockGetSchedule.mockResolvedValue({ ...mockScheduleData, workspaceId: "ws-1" });
    mockUpdateSchedule.mockResolvedValue({ ...mockScheduleData, name: "Updated" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/schedules/sched-1",
      payload: { name: "Updated" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for nonexistent schedule", async () => {
    mockGetSchedule.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/schedules/nonexistent",
      payload: { name: "Updated" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for schedule from another workspace", async () => {
    mockGetSchedule.mockResolvedValue({ ...mockScheduleData, workspaceId: "ws-other" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/schedules/sched-1",
      payload: { name: "Updated" },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/schedules/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a schedule", async () => {
    mockGetSchedule.mockResolvedValue({ ...mockScheduleData, workspaceId: "ws-1" });
    mockDeleteSchedule.mockResolvedValue(true);

    const res = await app.inject({ method: "DELETE", url: "/api/schedules/sched-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for nonexistent schedule", async () => {
    mockGetSchedule.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/schedules/nonexistent" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when deleting schedule from another workspace", async () => {
    mockGetSchedule.mockResolvedValue({ ...mockScheduleData, workspaceId: "ws-other" });

    const res = await app.inject({ method: "DELETE", url: "/api/schedules/sched-1" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/schedules/:id/trigger", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("manually triggers a schedule", async () => {
    mockGetSchedule.mockResolvedValue(mockScheduleData);
    mockCreateTask.mockResolvedValue({ id: "task-1", priority: 100, maxRetries: 1 });
    mockTransitionTask.mockResolvedValue(undefined);
    mockRecordRun.mockResolvedValue(undefined);

    const res = await app.inject({ method: "POST", url: "/api/schedules/sched-1/trigger" });

    expect(res.statusCode).toBe(200);
    expect(mockRecordRun).toHaveBeenCalledWith("sched-1", "task-1", "created");
  });

  it("returns 404 for nonexistent schedule", async () => {
    mockGetSchedule.mockResolvedValue(null);

    const res = await app.inject({ method: "POST", url: "/api/schedules/nonexistent/trigger" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/schedules/validate-cron", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("validates a cron expression", async () => {
    mockValidateCronExpression.mockReturnValue({ valid: true, nextRuns: [] });

    const res = await app.inject({
      method: "POST",
      url: "/api/schedules/validate-cron",
      payload: { cronExpression: "0 0 * * *" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });
});
