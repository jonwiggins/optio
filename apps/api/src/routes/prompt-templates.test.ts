import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockGetPromptTemplate = vi.fn();
const mockSaveDefaultPromptTemplate = vi.fn();
const mockSaveRepoPromptTemplate = vi.fn();
const mockListPromptTemplates = vi.fn();

vi.mock("../services/prompt-template-service.js", () => ({
  getPromptTemplate: (...args: unknown[]) => mockGetPromptTemplate(...args),
  saveDefaultPromptTemplate: (...args: unknown[]) => mockSaveDefaultPromptTemplate(...args),
  saveRepoPromptTemplate: (...args: unknown[]) => mockSaveRepoPromptTemplate(...args),
  listPromptTemplates: (...args: unknown[]) => mockListPromptTemplates(...args),
}));

const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbInsert = vi.fn();
const mockDbDelete = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    delete: () => ({ where: (...args: unknown[]) => mockDbDelete(...args) }),
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
  promptTemplates: {
    id: "id",
    name: "name",
    template: "template",
    repoUrl: "repoUrl",
    ownerUserId: "ownerUserId",
    workspaceId: "workspaceId",
  },
}));

const mockSeedStarterPrompts = vi.fn();
vi.mock("../services/starter-prompts.js", () => ({
  seedStarterPrompts: (...args: unknown[]) => mockSeedStarterPrompts(...args),
}));

vi.mock("@optio/shared", () => ({
  DEFAULT_PROMPT_TEMPLATE: "Default template content {{TASK_FILE}}",
  DEFAULT_REVIEW_PROMPT_TEMPLATE: "Default review template",
}));

import { promptTemplateRoutes } from "./prompt-templates.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(promptTemplateRoutes);
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

    expect(mockGetPromptTemplate).toHaveBeenCalledWith("https://github.com/org/repo");
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
    expect(mockSaveDefaultPromptTemplate).toHaveBeenCalledWith("New global template", false);
  });

  it("saves a repo-scoped template, never with auto-merge on (that needs a confirmation)", async () => {
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
      false,
    );
  });

  it("drops autoMerge on the global default too", async () => {
    mockSaveDefaultPromptTemplate.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "Global", autoMerge: true },
    });

    expect(res.statusCode).toBe(201);
    expect(mockSaveDefaultPromptTemplate).toHaveBeenCalledWith("Global", false);
  });

  it("saves a review template", async () => {
    // No existing review template
    mockDbSelect.mockResolvedValue([]);
    mockDbInsert.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "Review template", isReview: true },
    });

    expect(res.statusCode).toBe(201);
    expect(mockDbInsert).toHaveBeenCalled();
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

describe("the workspace's review prompt (review-default)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns the built-in prompt, marked unsaved, when the workspace saved none", async () => {
    mockDbSelect.mockResolvedValueOnce([]);
    const res = await app.inject({ method: "GET", url: "/api/prompt-templates/review-default" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      template: "Default review template",
      saved: false,
      builtin: "Default review template",
    });
  });

  it("prefers the workspace's saved prompt over the instance's", async () => {
    mockDbSelect.mockResolvedValueOnce([
      { template: "Instance prompt", workspaceId: null },
      { template: "Workspace prompt", workspaceId: "ws-1" },
    ]);
    const res = await app.inject({ method: "GET", url: "/api/prompt-templates/review-default" });
    expect(res.json()).toMatchObject({ template: "Workspace prompt", saved: true });
  });

  it("saving the built-in text deletes the saved row, so the built-in is followed again", async () => {
    mockDbSelect.mockResolvedValueOnce([{ id: "rd-1", workspaceId: "ws-1" }]);
    const res = await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "Default review template\n", isReview: true },
    });
    expect(res.statusCode).toBe(201);
    expect(mockDbDelete).toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("saves a new review prompt as the workspace's review-kind row", async () => {
    mockDbSelect.mockResolvedValueOnce([]);
    mockDbInsert.mockResolvedValueOnce(undefined);
    await app.inject({
      method: "POST",
      url: "/api/prompt-templates",
      payload: { template: "Our review prompt", isReview: true },
    });
    expect(mockDbInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "review-default",
        template: "Our review prompt",
        kind: "review",
        workspaceId: "ws-1",
      }),
    );
  });
});

describe("POST /api/prompt-templates/seed", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("restores the starter prompts and reports what changed", async () => {
    mockSeedStarterPrompts.mockResolvedValueOnce({ created: 2, restored: 1, unchanged: 10 });
    const res = await app.inject({ method: "POST", url: "/api/prompt-templates/seed" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 2, restored: 1, unchanged: 10 });
    expect(mockSeedStarterPrompts).toHaveBeenCalledWith({ restore: true });
  });
});
