import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockListRepos = vi.fn();
const mockGetRepo = vi.fn();
const mockGetRepoByUrl = vi.fn();
const mockCreateRepo = vi.fn();
const mockUpdateRepo = vi.fn();
const mockDeleteRepo = vi.fn();

vi.mock("../services/repo-service.js", () => ({
  listRepos: (...args: unknown[]) => mockListRepos(...args),
  getRepo: (...args: unknown[]) => mockGetRepo(...args),
  getRepoByUrl: (...args: unknown[]) => mockGetRepoByUrl(...args),
  createRepo: (...args: unknown[]) => mockCreateRepo(...args),
  updateRepo: (...args: unknown[]) => mockUpdateRepo(...args),
  deleteRepo: (...args: unknown[]) => mockDeleteRepo(...args),
}));

vi.mock("../services/secret-service.js", () => ({
  retrieveSecret: vi.fn().mockRejectedValue(new Error("not found")),
}));

vi.mock("../services/repo-detect-service.js", () => ({
  detectRepoConfig: vi.fn().mockResolvedValue({ imagePreset: "node", testCommand: "npm test" }),
}));

import { repoRoutes } from "./repos.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(repoRoutes);
}

const mockRepoData = {
  id: "repo-1",
  repoUrl: "https://github.com/org/repo",
  fullName: "org/repo",
  workspaceId: "ws-1",
  cpuRequest: null,
  cpuLimit: null,
  memoryRequest: null,
  memoryLimit: null,
};

describe("GET /api/repos", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists repos scoped to workspace", async () => {
    mockListRepos.mockResolvedValue([mockRepoData]);

    const res = await app.inject({ method: "GET", url: "/api/repos" });

    expect(res.statusCode).toBe(200);
    expect(res.json().repos).toHaveLength(1);
    expect(mockListRepos).toHaveBeenCalledWith("ws-1");
  });
});

describe("GET /api/repos/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns a repo", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().repo.id).toBe("repo-1");
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/api/repos/nonexistent" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for repo in different workspace", async () => {
    mockGetRepo.mockResolvedValue({ ...mockRepoData, workspaceId: "ws-other" });

    const res = await app.inject({ method: "GET", url: "/api/repos/repo-1" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/repos", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a repo", async () => {
    mockGetRepoByUrl.mockResolvedValue(null);
    mockCreateRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: {
        repoUrl: "https://github.com/org/repo",
        fullName: "org/repo",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://github.com/org/repo",
        fullName: "org/repo",
        workspaceId: "ws-1",
      }),
    );
  });

  it("rejects duplicate repo", async () => {
    mockGetRepoByUrl.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: {
        repoUrl: "https://github.com/org/repo",
        fullName: "org/repo",
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already been added");
  });

  it("rejects missing required fields (400 from Zod body schema)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/repos",
      payload: { repoUrl: "https://github.com/org/repo" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/repos/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a repo", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({ ...mockRepoData, imagePreset: "node" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { imagePreset: "node" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ imagePreset: "node" }),
    );
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/nonexistent",
      payload: { imagePreset: "node" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("accepts openclaw as the default agent type", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({ ...mockRepoData, defaultAgentType: "openclaw" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { defaultAgentType: "openclaw" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ defaultAgentType: "openclaw" }),
    );
  });

  it("persists openclawModel and openclawAgent settings", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({
      ...mockRepoData,
      openclawModel: "openclaw-model-x",
      openclawAgent: "build",
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { openclawModel: "openclaw-model-x", openclawAgent: "build" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ openclawModel: "openclaw-model-x", openclawAgent: "build" }),
    );
  });

  it("accepts null openclawModel and openclawAgent (clearing the fields)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({
      ...mockRepoData,
      openclawModel: null,
      openclawAgent: null,
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { openclawModel: null, openclawAgent: null },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ openclawModel: null, openclawAgent: null }),
    );
  });

  it("rejects invalid CPU quantity", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { cpuRequest: "invalid" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it("rejects invalid memory quantity", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { memoryRequest: "invalid" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("accepts a valid public Slack webhook URL", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({
      ...mockRepoData,
      slackWebhookUrl: "https://hooks.slack.com/services/T00/B00/xxxx",
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "https://hooks.slack.com/services/T00/B00/xxxx" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateRepo).toHaveBeenCalledWith(
      "repo-1",
      expect.objectContaining({ slackWebhookUrl: "https://hooks.slack.com/services/T00/B00/xxxx" }),
    );
  });

  it("accepts null slackWebhookUrl (clearing the field)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockUpdateRepo.mockResolvedValue({ ...mockRepoData, slackWebhookUrl: null });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: null },
    });

    expect(res.statusCode).toBe(200);
  });

  it("rejects slackWebhookUrl targeting localhost (SSRF)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "http://localhost:8080/hook" },
    });

    expect(res.statusCode).toBe(400); // Zod validation error via type provider
  });

  it("rejects slackWebhookUrl targeting internal K8s address (SSRF)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "http://postgres.default.svc.cluster.local:5432" },
    });

    expect(res.statusCode).toBe(400); // Zod validation error via type provider
  });

  it("rejects slackWebhookUrl targeting AWS metadata endpoint (SSRF)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "http://169.254.169.254/latest/meta-data/" },
    });

    expect(res.statusCode).toBe(400); // Zod validation error via type provider
  });

  it("rejects slackWebhookUrl targeting private IP (SSRF)", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "http://10.0.0.1:8080/hook" },
    });

    expect(res.statusCode).toBe(400); // Zod validation error via type provider
  });

  it("rejects slackWebhookUrl that is not a valid URL", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/repos/repo-1",
      payload: { slackWebhookUrl: "not-a-url" },
    });

    expect(res.statusCode).toBe(400); // Zod validation error via type provider
  });
});

describe("DELETE /api/repos/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a repo", async () => {
    mockGetRepo.mockResolvedValue(mockRepoData);
    mockDeleteRepo.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/repos/repo-1" });

    expect(res.statusCode).toBe(204);
    expect(mockDeleteRepo).toHaveBeenCalledWith("repo-1");
  });

  it("returns 404 for nonexistent repo", async () => {
    mockGetRepo.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/repos/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});
