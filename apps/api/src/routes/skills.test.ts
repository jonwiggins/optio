import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockListSkills = vi.fn();
const mockGetSkill = vi.fn();
const mockCreateSkill = vi.fn();
const mockUpdateSkill = vi.fn();
const mockDeleteSkill = vi.fn();

vi.mock("../services/skill-service.js", () => ({
  listSkills: (...args: unknown[]) => mockListSkills(...args),
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
  createSkill: (...args: unknown[]) => mockCreateSkill(...args),
  updateSkill: (...args: unknown[]) => mockUpdateSkill(...args),
  deleteSkill: (...args: unknown[]) => mockDeleteSkill(...args),
}));

import { skillRoutes } from "./skills.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(skillRoutes);
}

describe("GET /api/skills", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists skills", async () => {
    mockListSkills.mockResolvedValue([{ id: "skill-1", name: "lint" }]);

    const res = await app.inject({ method: "GET", url: "/api/skills" });

    expect(res.statusCode).toBe(200);
    expect(res.json().skills).toHaveLength(1);
    expect(mockListSkills).toHaveBeenCalledWith(undefined, "ws-1", {
      userId: "user-1",
      workspaceId: "ws-1",
      isAdmin: true,
    });
  });
});

describe("POST /api/skills", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a skill", async () => {
    mockCreateSkill.mockResolvedValue({ id: "skill-1", name: "lint" });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { name: "lint", prompt: "Run linting" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "lint", prompt: "Run linting" }),
      "ws-1",
    );
  });

  it("rejects missing prompt (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { name: "lint" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("accepts skill-dir layout with extra files and agentTypes", async () => {
    mockCreateSkill.mockResolvedValue({ id: "skill-1", name: "review" });

    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: {
        name: "review",
        prompt: "Review code carefully",
        layout: "skill-dir",
        files: [{ relativePath: "reference.md", content: "# Ref" }],
        agentTypes: ["claude-code"],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        layout: "skill-dir",
        files: [{ relativePath: "reference.md", content: "# Ref" }],
        agentTypes: ["claude-code"],
      }),
      "ws-1",
    );
  });

  it("rejects an invalid layout value", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { name: "x", prompt: "y", layout: "bogus" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("PATCH /api/skills/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("updates a skill", async () => {
    mockGetSkill.mockResolvedValue({ id: "skill-1" });
    mockUpdateSkill.mockResolvedValue({ id: "skill-1", enabled: false });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/skills/skill-1",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it("returns 404 for nonexistent skill", async () => {
    mockGetSkill.mockResolvedValue(null);

    const res = await app.inject({
      method: "PATCH",
      url: "/api/skills/nonexistent",
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/skills/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a skill", async () => {
    mockGetSkill.mockResolvedValue({ id: "skill-1" });
    mockDeleteSkill.mockResolvedValue(undefined);

    const res = await app.inject({ method: "DELETE", url: "/api/skills/skill-1" });

    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for nonexistent skill", async () => {
    mockGetSkill.mockResolvedValue(null);

    const res = await app.inject({ method: "DELETE", url: "/api/skills/nonexistent" });

    expect(res.statusCode).toBe(404);
  });
});
