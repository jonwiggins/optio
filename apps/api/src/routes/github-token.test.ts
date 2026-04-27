import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockRetrieveSecret = vi.fn();
const mockStoreSecret = vi.fn();
const mockListSecrets = vi.fn();

vi.mock("../services/secret-service.js", () => ({
  retrieveSecret: (...args: unknown[]) => mockRetrieveSecret(...args),
  storeSecret: (...args: unknown[]) => mockStoreSecret(...args),
  listSecrets: (...args: unknown[]) => mockListSecrets(...args),
}));

const mockIsGitHubAppConfigured = vi.fn();

vi.mock("../services/github-app-service.js", () => ({
  isGitHubAppConfigured: (...args: unknown[]) => mockIsGitHubAppConfigured(...args),
}));

vi.mock("../services/oauth/index.js", () => ({
  isAuthDisabled: () => true,
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { githubTokenRoutes } from "./github-token.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(githubTokenRoutes, { user: null });
}

describe("GET /api/github-token/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsGitHubAppConfigured.mockReturnValue(false);
    app = await buildTestApp();
  });

  it("returns valid status when stored token is valid", async () => {
    mockRetrieveSecret.mockResolvedValue("ghp_validtoken123");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ login: "testuser", name: "Test User" }),
    });

    const res = await app.inject({ method: "GET", url: "/api/github-token/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("valid");
    expect(body.user).toEqual({ login: "testuser", name: "Test User" });
    expect(body.source).toBe("pat");
  });

  it("returns expired status when stored token fails GitHub validation", async () => {
    mockRetrieveSecret.mockResolvedValue("ghp_expiredtoken");
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
    });

    const res = await app.inject({ method: "GET", url: "/api/github-token/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("expired");
    expect(body.error).toContain("401");
  });

  it("returns missing status when no token is stored", async () => {
    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    mockIsGitHubAppConfigured.mockReturnValue(false);

    const res = await app.inject({ method: "GET", url: "/api/github-token/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("missing");
  });

  it("returns github_app source when GitHub App is configured and no PAT", async () => {
    mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
    mockIsGitHubAppConfigured.mockReturnValue(true);

    const res = await app.inject({ method: "GET", url: "/api/github-token/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("valid");
    expect(body.source).toBe("github_app");
  });

  it("returns error status when GitHub API is unreachable", async () => {
    mockRetrieveSecret.mockResolvedValue("ghp_sometoken");
    mockFetch.mockRejectedValue(new Error("Network error"));

    const res = await app.inject({ method: "GET", url: "/api/github-token/status" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("error");
  });
});

describe("POST /api/github-token/rotate", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("validates and stores a new token successfully", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ login: "newuser", name: "New User" }),
    });
    mockStoreSecret.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/github-token/rotate",
      payload: { token: "ghp_newvalidtoken" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.user).toEqual({ login: "newuser", name: "New User" });
    expect(mockStoreSecret).toHaveBeenCalledWith(
      "GITHUB_TOKEN",
      "ghp_newvalidtoken",
      "global",
      undefined,
    );
  });

  it("rejects an invalid token without storing it", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/github-token/rotate",
      payload: { token: "ghp_badtoken" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
    expect(mockStoreSecret).not.toHaveBeenCalled();
  });

  it("returns 400 when token is missing from request body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/github-token/rotate",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns failure when GitHub API is unreachable during rotation", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const res = await app.inject({
      method: "POST",
      url: "/api/github-token/rotate",
      payload: { token: "ghp_sometoken" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(mockStoreSecret).not.toHaveBeenCalled();
  });
});
