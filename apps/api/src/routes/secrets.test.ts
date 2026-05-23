import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListSecrets = vi.fn();
const mockStoreSecret = vi.fn();
const mockDeleteSecret = vi.fn();

vi.mock("../services/secret-service.js", () => ({
  listSecrets: (...args: unknown[]) => mockListSecrets(...args),
  storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
  deleteSecret: (...args: unknown[]) => mockDeleteSecret(...args),
}));

import { secretRoutes } from "./secrets.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(secretRoutes);
}

describe("GET /api/secrets", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("lists secrets with workspace scoping and includes user-scoped secrets", async () => {
    // First call: workspace-scoped secrets, second call: user-scoped secrets
    mockListSecrets
      .mockResolvedValueOnce([
        { name: "GITHUB_TOKEN", scope: "global" },
        { name: "NPM_TOKEN", scope: "global" },
      ])
      .mockResolvedValueOnce([{ name: "ANTHROPIC_API_KEY", scope: "user", userId: "user-1" }]);

    const res = await app.inject({ method: "GET", url: "/api/secrets" });

    expect(res.statusCode).toBe(200);
    expect(res.json().secrets).toHaveLength(3);
    // Workspace-scoped call: listSecrets(scope, workspaceId)
    expect(mockListSecrets).toHaveBeenNthCalledWith(1, undefined, "ws-1");
    // User-scoped call: listSecrets("user", null, userId)
    expect(mockListSecrets).toHaveBeenNthCalledWith(2, "user", null, "user-1");
  });

  it("passes scope query parameter", async () => {
    mockListSecrets.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/api/secrets?scope=repo:my-repo" });

    expect(res.statusCode).toBe(200);
    // With scope filter, still queries both workspace and user-scoped
    expect(mockListSecrets).toHaveBeenNthCalledWith(1, "repo:my-repo", "ws-1");
    expect(mockListSecrets).toHaveBeenNthCalledWith(2, "user", null, "user-1");
  });

  it("returns only user-scoped secrets when scope=user", async () => {
    mockListSecrets.mockResolvedValue([
      { name: "ANTHROPIC_API_KEY", scope: "user", userId: "user-1" },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/secrets?scope=user" });

    expect(res.statusCode).toBe(200);
    expect(res.json().secrets).toHaveLength(1);
    // Only one call: user-scoped
    expect(mockListSecrets).toHaveBeenCalledTimes(1);
    expect(mockListSecrets).toHaveBeenCalledWith("user", null, "user-1");
  });
});

describe("POST /api/secrets", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("creates a secret with workspaceId stripped for global scope (#509)", async () => {
    mockStoreSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "MY_SECRET", value: "super-secret-value" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: "MY_SECRET", scope: "global" });
    expect(mockStoreSecret).toHaveBeenCalledWith(
      "MY_SECRET",
      "super-secret-value",
      "global",
      null,
      null,
    );
  });

  it("creates a secret with custom scope", async () => {
    mockStoreSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "REPO_KEY", value: "val", scope: "repo:my-repo" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: "REPO_KEY", scope: "repo:my-repo" });
    expect(mockStoreSecret).toHaveBeenCalledWith("REPO_KEY", "val", "repo:my-repo", "ws-1", null);
  });

  it("creates a user-scoped secret with caller userId", async () => {
    mockStoreSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "MY_USER_TOKEN", value: "tok-123", scope: "user" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: "MY_USER_TOKEN", scope: "user" });
    // userId should be set to the caller's id ("user-1" from test harness)
    expect(mockStoreSecret).toHaveBeenCalledWith(
      "MY_USER_TOKEN",
      "tok-123",
      "user",
      "ws-1",
      "user-1",
    );
  });

  it("rejects missing name (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { value: "val" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects missing value (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "KEY" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects empty name (Zod throws)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "", value: "val" },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/secrets/:name", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("deletes a secret", async () => {
    mockDeleteSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/secrets/MY_SECRET",
    });

    expect(res.statusCode).toBe(204);
    expect(mockDeleteSecret).toHaveBeenCalledWith("MY_SECRET", undefined, "ws-1", null);
  });

  it("passes scope query parameter when deleting", async () => {
    mockDeleteSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/secrets/MY_SECRET?scope=repo:r",
    });

    expect(res.statusCode).toBe(204);
    expect(mockDeleteSecret).toHaveBeenCalledWith("MY_SECRET", "repo:r", "ws-1", null);
  });

  it("deletes user-scoped secret with caller userId", async () => {
    mockDeleteSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/secrets/MY_TOKEN?scope=user",
    });

    expect(res.statusCode).toBe(204);
    // userId should be set to the caller's id ("user-1") for user-scoped deletion
    expect(mockDeleteSecret).toHaveBeenCalledWith("MY_TOKEN", "user", "ws-1", "user-1");
  });
});
