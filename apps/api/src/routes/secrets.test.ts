import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockListVisibleSecrets = vi.fn();
const mockStoreSecret = vi.fn();
const mockDeleteSecret = vi.fn();

vi.mock("../services/secret-service.js", () => ({
  listVisibleSecrets: (...args: unknown[]) => mockListVisibleSecrets(...args),
  storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
  deleteSecret: (...args: unknown[]) => mockDeleteSecret(...args),
}));

/** The route test harness's default user, as the ownership rule's actor. */
const ACTOR = { userId: "user-1", workspaceId: "ws-1", isAdmin: true };

vi.mock("../services/event-bus.js", () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));

const mockValidateClaudeToken = vi.fn();
const mockRecordTokenValidation = vi.fn();
vi.mock("../workers/token-validation-worker.js", () => ({
  validateClaudeToken: (...args: unknown[]) => mockValidateClaudeToken(...args),
  recordTokenValidation: (...args: unknown[]) => mockRecordTokenValidation(...args),
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

  it("lists the secrets the caller may see — the organization's and their own — in one call", async () => {
    mockListVisibleSecrets.mockResolvedValue([
      { name: "GITHUB_TOKEN", scope: "global", ownerUserId: null, ownerName: null },
      { name: "NPM_TOKEN", scope: "global", ownerUserId: null, ownerName: null },
      { name: "ANTHROPIC_API_KEY", scope: "user", userId: "user-1", ownerUserId: "user-1" },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/secrets" });

    expect(res.statusCode).toBe(200);
    expect(res.json().secrets).toHaveLength(3);
    expect(mockListVisibleSecrets).toHaveBeenCalledTimes(1);
    expect(mockListVisibleSecrets).toHaveBeenCalledWith(ACTOR, undefined);
  });

  it("passes the scope filter through", async () => {
    mockListVisibleSecrets.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/api/secrets?scope=repo:my-repo" });

    expect(res.statusCode).toBe(200);
    expect(mockListVisibleSecrets).toHaveBeenCalledWith(ACTOR, "repo:my-repo");
  });

  it("narrows to private secrets when scope=user", async () => {
    mockListVisibleSecrets.mockResolvedValue([
      { name: "ANTHROPIC_API_KEY", scope: "user", userId: "user-1", ownerUserId: "user-1" },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/secrets?scope=user" });

    expect(res.statusCode).toBe(200);
    expect(res.json().secrets).toHaveLength(1);
    expect(mockListVisibleSecrets).toHaveBeenCalledWith(ACTOR, "user");
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

  it("validates a global Claude token with the worker's check and records the verdict", async () => {
    mockStoreSecret.mockResolvedValue(undefined);
    mockValidateClaudeToken.mockResolvedValue({ valid: true });
    mockRecordTokenValidation.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-fresh" },
    });

    expect(res.statusCode).toBe(201);
    expect(mockValidateClaudeToken).toHaveBeenCalledWith("sk-ant-oat01-fresh");
    // The cached "expired" status is replaced right away, not at the next 5-min check.
    expect(mockRecordTokenValidation).toHaveBeenCalledWith({ valid: true, tokenExists: true });
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
    // A private secret is the caller's ("user-1" from the test harness) and is
    // stored without a workspace: readers look it up by user alone, so a
    // workspace in its encryption context would make it undecryptable.
    expect(mockStoreSecret).toHaveBeenCalledWith(
      "MY_USER_TOKEN",
      "tok-123",
      "user",
      null,
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
