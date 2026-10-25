import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

/** PATCH /api/task-configs/:id — the auto-merge confirmation, stamped with when and who. */

const mockGetTaskConfig = vi.fn();
const mockUpdateTaskConfig = vi.fn();
vi.mock("../services/task-config-service.js", () => ({
  getTaskConfig: (...args: unknown[]) => mockGetTaskConfig(...args),
  updateTaskConfig: (...args: unknown[]) => mockUpdateTaskConfig(...args),
  createTaskConfig: vi.fn(),
  listTaskConfigs: vi.fn(),
  deleteTaskConfig: vi.fn(),
  instantiateTask: vi.fn(),
}));

vi.mock("../services/trigger-service.js", () => ({}));

vi.mock("../services/local-run-service.js", () => ({
  validateRunLocation: vi.fn(),
}));

vi.mock("../services/work-ownership.js", () => ({
  planNewWork: vi.fn(),
  planWorkUpdate: vi.fn(async (existing: { ownerUserId: string | null }) => ({
    ok: true,
    ownerUserId: existing.ownerUserId,
    ownerTeamId: null,
  })),
  workActor: vi.fn(() => ({ userId: "user-1", workspaceId: "ws-1", isAdmin: true })),
  workChangeError: vi.fn(),
}));

vi.mock("../services/optio-action-service.js", () => ({
  logAction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/ownership.js", () => ({
  actorOf: vi.fn(() => ({ userId: "user-1", workspaceId: "ws-1", isAdmin: true })),
  withOwnerNames: vi.fn(async (rows: unknown[]) => rows),
}));

vi.mock("../services/work-visibility.js", () => ({ canSeeWork: vi.fn(() => true) }));

vi.mock("../services/config/managed.js", () => ({
  withManagedBy: vi.fn(async (rows: unknown[]) => rows),
}));

import { taskConfigRoutes } from "./task-configs.js";

const config = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Nightly deps",
  description: null,
  workspaceId: "ws-1",
  title: "Bump deps",
  prompt: "Bump the dependencies",
  promptTemplateId: null,
  repoUrl: "https://gitlab.example.com/acme/api",
  repoBranch: "main",
  agentType: "claude-code",
  maxRetries: 3,
  priority: 100,
  agentOptions: null,
  runTarget: "cluster",
  localHostId: null,
  localDir: null,
  localSessionMode: null,
  autoResume: true,
  autoMerge: null,
  autoMergeConfirmedAt: null,
  enabled: true,
  ownerUserId: null,
  ownerTeamId: null,
  podSecrets: null,
  settings: null,
  createdBy: "user-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("PATCH /api/task-configs/:id — auto-merge confirmation", () => {
  // The deployment asks for the confirmation (off by default).
  beforeEach(() => {
    process.env.OPTIO_MERGE_CONFIRMATION = "true";
  });
  afterEach(() => {
    delete process.env.OPTIO_MERGE_CONFIRMATION;
  });
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetTaskConfig.mockResolvedValue(config);
    mockUpdateTaskConfig.mockImplementation(async (_id: string, patch: object) => ({
      ...config,
      ...patch,
    }));
    app = await buildRouteTestApp(taskConfigRoutes);
  });

  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/task-configs/${config.id}`, payload });

  it("turning merging on with the dialog stamps when and who", async () => {
    const res = await patch({ autoMerge: true, autoMergeConfirmed: true });
    expect(res.statusCode, res.body).toBe(200);
    const [, input] = mockUpdateTaskConfig.mock.calls[0];
    expect(input).toMatchObject({ autoMerge: true, autoMergeConfirmedBy: "user-1" });
    expect(input.autoMergeConfirmedAt).toBeInstanceOf(Date);
    expect(input).not.toHaveProperty("autoMergeConfirmed");
  });

  it("refuses to turn it on without the dialog", async () => {
    const res = await patch({ autoMerge: true });
    expect(res.statusCode).toBe(400);
    expect(mockUpdateTaskConfig).not.toHaveBeenCalled();
  });

  it("turning it off clears the stamp, and an unrelated edit leaves it alone", async () => {
    await patch({ autoMerge: false });
    expect(mockUpdateTaskConfig.mock.calls[0][1]).toMatchObject({
      autoMerge: false,
      autoMergeConfirmedAt: null,
      autoMergeConfirmedBy: null,
    });

    mockGetTaskConfig.mockResolvedValue({
      ...config,
      autoMerge: true,
      autoMergeConfirmedAt: new Date("2026-02-01T00:00:00Z"),
    });
    const res = await patch({ name: "Weekly deps", autoMerge: true });
    expect(res.statusCode, res.body).toBe(200);
    const input = mockUpdateTaskConfig.mock.calls[1][1];
    expect(input).not.toHaveProperty("autoMergeConfirmedAt");
    expect(input).not.toHaveProperty("autoMergeConfirmedBy");
  });
});
