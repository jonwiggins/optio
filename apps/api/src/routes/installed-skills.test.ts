import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockList = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/installed-skill-service.js", () => ({
  listInstalledSkills: (...args: unknown[]) => mockList(...args),
  getInstalledSkill: (...args: unknown[]) => mockGet(...args),
  createInstalledSkill: (...args: unknown[]) => mockCreate(...args),
  updateInstalledSkill: (...args: unknown[]) => mockUpdate(...args),
  deleteInstalledSkill: (...args: unknown[]) => mockDelete(...args),
}));

vi.mock("../workers/skill-sync-worker.js", () => ({
  skillSyncQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

import { installedSkillRoutes } from "./installed-skills.js";

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(installedSkillRoutes);
}

describe("POST /api/installed-skills", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a skill and enqueues an eager sync", async () => {
    mockCreate.mockResolvedValue({ id: "skill-1", name: "superpowers" });

    const res = await app.inject({
      method: "POST",
      url: "/api/installed-skills",
      payload: {
        name: "superpowers",
        sourceUrl: "https://github.com/example/skills.git",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "superpowers",
        sourceUrl: "https://github.com/example/skills.git",
      }),
      "ws-1",
    );
    expect(mockQueueAdd).toHaveBeenCalledWith("sync-one", { id: "skill-1" }, expect.any(Object));
  });

  it("rejects missing sourceUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/installed-skills",
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid skill name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/installed-skills",
      payload: {
        name: "Has Spaces",
        sourceUrl: "https://example.com/x.git",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 if the service throws (e.g. invalid subpath)", async () => {
    mockCreate.mockRejectedValue(new Error("invalid subpath: ../escape"));

    const res = await app.inject({
      method: "POST",
      url: "/api/installed-skills",
      payload: {
        name: "x",
        sourceUrl: "https://example.com/x.git",
        subpath: "../escape",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid subpath/);
  });
});

describe("POST /api/installed-skills/:id/sync", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("enqueues a sync for an existing skill", async () => {
    mockGet.mockResolvedValue({ id: "skill-1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/installed-skills/skill-1/sync",
    });

    expect(res.statusCode).toBe(202);
    expect(mockQueueAdd).toHaveBeenCalledWith("sync-one", { id: "skill-1" }, expect.any(Object));
  });

  it("returns 404 for an unknown skill", async () => {
    mockGet.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/installed-skills/unknown/sync",
    });
    expect(res.statusCode).toBe(404);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/installed-skills/:id", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("re-syncs when ref changes", async () => {
    mockGet.mockResolvedValue({ id: "skill-1", ref: "main" });
    mockUpdate.mockResolvedValue({ id: "skill-1", ref: "v2.0.0" });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/installed-skills/skill-1",
      payload: { ref: "v2.0.0" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it("does not re-sync when only enabled changes", async () => {
    mockGet.mockResolvedValue({ id: "skill-1" });
    mockUpdate.mockResolvedValue({ id: "skill-1", enabled: false });

    const res = await app.inject({
      method: "PATCH",
      url: "/api/installed-skills/skill-1",
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
