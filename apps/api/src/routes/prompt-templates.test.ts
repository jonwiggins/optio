import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockGetPromptTemplate = vi.fn();
const mockSaveDefaultPromptTemplate = vi.fn();
const mockSaveRepoPromptTemplate = vi.fn();
const mockListPromptTemplates = vi.fn();
const mockGetReviewDefaultTemplate = vi.fn();
const mockSaveReviewDefaultTemplate = vi.fn();

vi.mock("../services/prompt-template-service.js", () => ({
  getPromptTemplate: (...args: unknown[]) => mockGetPromptTemplate(...args),
  saveDefaultPromptTemplate: (...args: unknown[]) => mockSaveDefaultPromptTemplate(...args),
  saveRepoPromptTemplate: (...args: unknown[]) => mockSaveRepoPromptTemplate(...args),
  listPromptTemplates: (...args: unknown[]) => mockListPromptTemplates(...args),
  getReviewDefaultTemplate: (...args: unknown[]) => mockGetReviewDefaultTemplate(...args),
  saveReviewDefaultTemplate: (...args: unknown[]) => mockSaveReviewDefaultTemplate(...args),
}));

const mockIsDeploymentAdmin = vi.fn();
vi.mock("../services/sign-in-config-service.js", () => ({
  isDeploymentAdmin: (...args: unknown[]) => mockIsDeploymentAdmin(...args),
  hasDeploymentAdmin: async () => true,
  isFoundingWorkspaceAdmin: async () => false,
}));

const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbInsert = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (...args: unknown[]) => mockDbSelect(...args),
      }),
    }),
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => mockDbUpdate(...args),
      }),
    }),
    insert: () => ({
      values: (...args: unknown[]) => mockDbInsert(...args),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  promptTemplates: { id: "id", name: "name", repoUrl: "repoUrl" },
}));

vi.mock("@optio/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@optio/shared")>()),
  DEFAULT_PROMPT_TEMPLATE: "Default template content {{TASK_FILE}}",
  DEFAULT_REVIEW_PROMPT_TEMPLATE: "Default review template",
}));

import { promptTemplateRoutes } from "./prompt-templates.js";

// ─── Helpers ───

async function buildTestApp(user?: {
  id: string;
  workspaceId: string | null;
  workspaceRole: "admin" | "member" | "viewer";
}): Promise<FastifyInstance> {
  return buildRouteTestApp(promptTemplateRoutes, user ? { user } : {});
}

describe("GET /api/prompt-templates/effective", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns effective template", async () => {
    mockGetPromptTemplate.mockResolvedValue({ template: "Custom template", isDefault: false });

    const res = await app.inject({ method: "GET", url: "/api/prompt-templates/effective" });

    expect(res.statusCode).toBe(200);
    expect(res.json().template).toBe("Custom template");
  });

  it("passes repoUrl query param", async () => {
    mockGetPromptTemplate.mockResolvedValue({ template: "Repo template" });

    await app.inject({
      method: "GET",
      url: "/api/prompt-templates/effective?repoUrl=https://github.com/org/repo",
    });

    // Resolved in the caller's workspace, never across workspaces.
    expect(mockGetPromptTemplate).toHaveBeenCalledWith("https://github.com/org/repo", {
      workspaceId: "ws-1",
    });
  });
});

describe("GET /api/prompt-templates/review-default", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the workspace's (else the deployment's) review default", async () => {
    mockGetReviewDefaultTemplate.mockResolvedValue("Saved review");
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/prompt-templates/review-default" });
    expect(res.json()).toEqual({ template: "Saved review" });
    expect(mockGetReviewDefaultTemplate).toHaveBeenCalledWith("ws-1");
  });

  it("falls back to the built-in review prompt", async () => {
    mockGetReviewDefaultTemplate.mockResolvedValue(null);
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/prompt-templates/review-default" });
    expect(res.json()).toEqual({ template: "Default review template" });
  });
});

describe("GET /api/prompt-templates/builtin-default", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns the hardcoded default template", async () => {
    const res = await app.inject({ method: "GET", url: "/api/prompt-templates/builtin-default" });

    expect(res.statusCode).toBe(200);
    expect(res.json().template).toContain("TASK_FILE");
  });
});

describe("GET /api/prompt-templates", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists all templates", async () => {
    mockListPromptTemplates.mockResolvedValue([{ id: "t-1", name: "default" }]);

    const res = await app.inject({ method: "GET", url: "/api/prompt-templates" });

    expect(res.statusCode).toBe(200);
    expect(res.json().templates).toHaveLength(1);
  });
});

describe("POST /api/prompt-templates", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("saves a global default template", async () => {
    mockSaveDefaultPromptTemplate.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "New global template" },
    });

    expect(res.statusCode).toBe(201);
    // The caller's workspace's default, not the deployment's.
    expect(mockSaveDefaultPromptTemplate).toHaveBeenCalledWith(
      "New global template",
      false,
      "ws-1",
    );
  });

  it("refuses a workspace member: the workspace's default is its admins'", async () => {
    app = await buildTestApp({ id: "user-2", workspaceId: "ws-1", workspaceRole: "member" });
    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "Mine now" },
    });
    expect(res.statusCode).toBe(403);
    const review = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "Mine now", isReview: true },
    });
    expect(review.statusCode).toBe(403);
    expect(mockSaveDefaultPromptTemplate).not.toHaveBeenCalled();
    expect(mockSaveReviewDefaultTemplate).not.toHaveBeenCalled();
  });

  it("saves the deployment's default only for a deployment admin", async () => {
    mockIsDeploymentAdmin.mockResolvedValue(false);
    const refused = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "For everyone", scope: "deployment" },
    });
    expect(refused.statusCode).toBe(403);
    expect(mockSaveDefaultPromptTemplate).not.toHaveBeenCalled();

    mockIsDeploymentAdmin.mockResolvedValue(true);
    const ok = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "For everyone", scope: "deployment" },
    });
    expect(ok.statusCode).toBe(201);
    expect(mockSaveDefaultPromptTemplate).toHaveBeenCalledWith("For everyone", false, null);
  });

  it("saves a repo-scoped template", async () => {
    mockSaveRepoPromptTemplate.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: {
        template: "Repo template",
        repoUrl: "https://github.com/org/repo",
        autoMerge: true,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockSaveRepoPromptTemplate).toHaveBeenCalledWith(
      "https://github.com/org/repo",
      "Repo template",
      true,
      "ws-1",
    );
  });

  it("saves a review template", async () => {
    mockSaveReviewDefaultTemplate.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "Review template", isReview: true },
    });

    expect(res.statusCode).toBe(201);
    expect(mockSaveReviewDefaultTemplate).toHaveBeenCalledWith("Review template", "ws-1");
  });

  it("rejects empty template (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "" },
    });

    expect(res.statusCode).toBe(400);
  });
});
