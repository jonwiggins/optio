import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { AUTO_MERGE_CONFIRMATION_MESSAGE } from "@optio/shared";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// PATCH /api/repos/:id under the deployment's merge confirmation
// (docs/merge-confirmation.md): turning automatic merging on needs the
// dialog, stamps who and when, and an off clears the stamp.

const mockGetRepo = vi.fn();
const mockUpdateRepo = vi.fn();
const mockRequired = vi.fn();
const mockAudit = vi.fn();

vi.mock("../services/repo-service.js", () => ({
  getRepo: (...args: unknown[]) => mockGetRepo(...args),
  updateRepo: (...args: unknown[]) => mockUpdateRepo(...args),
  autoMergeConfirmerName: vi.fn().mockResolvedValue("Ann Lee"),
}));
vi.mock("../services/deployment-settings.js", () => ({
  mergeConfirmationRequired: () => mockRequired(),
}));
vi.mock("../services/audit.js", () => ({
  auditAutoMergeSetting: (...args: unknown[]) => mockAudit(...args),
}));
vi.mock("../services/config/managed.js", () => ({
  withManagedBy: async (rows: unknown[]) => rows,
}));

import { repoRoutes } from "./repos.js";

const repo = {
  id: "repo-1",
  repoUrl: "https://github.com/org/repo",
  fullName: "org/repo",
  workspaceId: "ws-1",
  autoMerge: false,
  autoMergeConfirmedAt: null,
  cpuRequest: null,
  cpuLimit: null,
  memoryRequest: null,
  memoryLimit: null,
};

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetRepo.mockResolvedValue(repo);
  mockUpdateRepo.mockImplementation(async (_id: string, data: object) => ({ ...repo, ...data }));
  app = await buildRouteTestApp(repoRoutes);
});

const patch = (payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: "/api/repos/repo-1", payload });

describe("with the merge confirmation on", () => {
  beforeEach(() => mockRequired.mockResolvedValue(true));

  it("refuses turning merging on without the dialog", async () => {
    const res = await patch({ autoMerge: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(AUTO_MERGE_CONFIRMATION_MESSAGE);
    expect(mockUpdateRepo).not.toHaveBeenCalled();
  });

  it("stamps who confirmed it and when, and audits it", async () => {
    const res = await patch({ autoMerge: true, autoMergeConfirmed: true });
    expect(res.statusCode).toBe(200);
    const [, data] = mockUpdateRepo.mock.calls[0];
    expect(data).toMatchObject({ autoMerge: true, autoMergeConfirmedBy: "user-1" });
    expect(data.autoMergeConfirmedAt).toBeInstanceOf(Date);
    // The flag itself is not a column.
    expect(data).not.toHaveProperty("autoMergeConfirmed");
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      { autoMerge: true, autoMergeConfirmed: true },
      { type: "repo", id: "repo-1" },
      repo,
    );
  });

  it("saving an already confirmed setting again doesn't ask twice and keeps the stamp", async () => {
    mockGetRepo.mockResolvedValue({ ...repo, autoMerge: true, autoMergeConfirmedAt: new Date() });
    const res = await patch({ autoMerge: true, imagePreset: "node" });
    expect(res.statusCode).toBe(200);
    const [, data] = mockUpdateRepo.mock.calls[0];
    expect(data).not.toHaveProperty("autoMergeConfirmedAt");
  });

  it("turning it off clears the stamp", async () => {
    mockGetRepo.mockResolvedValue({ ...repo, autoMerge: true, autoMergeConfirmedAt: new Date() });
    await patch({ autoMerge: false });
    const [, data] = mockUpdateRepo.mock.calls[0];
    expect(data).toMatchObject({ autoMergeConfirmedAt: null, autoMergeConfirmedBy: null });
  });

  it("stores a review depth, and null returns to the workspace's", async () => {
    await patch({ reviewDepth: "light" });
    expect(mockUpdateRepo.mock.calls[0][1]).toMatchObject({ reviewDepth: "light" });
    await patch({ reviewDepth: null });
    expect(mockUpdateRepo.mock.calls[1][1]).toMatchObject({ reviewDepth: null });
    expect((await patch({ reviewDepth: "deep" })).statusCode).toBe(400);
  });
});

describe("with the merge confirmation off (the default)", () => {
  beforeEach(() => mockRequired.mockResolvedValue(false));

  it("the checkbox alone turns merging on, as before, with no stamp", async () => {
    const res = await patch({ autoMerge: true });
    expect(res.statusCode).toBe(200);
    const [, data] = mockUpdateRepo.mock.calls[0];
    expect(data).toMatchObject({ autoMerge: true });
    expect(data).not.toHaveProperty("autoMergeConfirmedAt");
  });
});
