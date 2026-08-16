import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockGetGitHubToken = vi.fn();
vi.mock("../services/github-token-service.js", () => ({
  getGitHubToken: (...args: unknown[]) => mockGetGitHubToken(...args),
}));

const mockIsGitHubAppConfigured = vi.fn();
vi.mock("../services/github-app-service.js", () => ({
  isGitHubAppConfigured: (...args: unknown[]) => mockIsGitHubAppConfigured(...args),
}));

import githubAppRoutes from "./github-app.js";
import {
  getCredentialSecret,
  resetCredentialSecret,
} from "../services/credential-secret-service.js";
import { computeSignature } from "../services/hmac-auth-service.js";

// ─── Helpers ───

// Ensure the credential secret is derived from a known key, regardless of
// module load order in the test suite.
process.env.OPTIO_ENCRYPTION_KEY = "test-encryption-key-for-unit-tests";
resetCredentialSecret();
const SECRET = getCredentialSecret();
const VALID_BEARER = `Bearer ${SECRET}`;

function makeHmacHeaders(path: string, timestampOverride?: number): Record<string, string> {
  const ts = timestampOverride ?? Math.floor(Date.now() / 1000);
  const sig = computeSignature(SECRET, ts, path);
  return { "x-optio-signature": `t=${ts},sig=${sig}` };
}

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(githubAppRoutes, { user: null });
}

// ─── Tests ───

describe("GET /api/internal/git-credentials", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    delete process.env.OPTIO_ALLOW_LEGACY_INTERNAL_BEARER;
    vi.unstubAllGlobals();
  });

  // --- HMAC signature auth ---

  it("returns token with valid HMAC signature", async () => {
    mockGetGitHubToken.mockResolvedValue("ghp_server_token");
    const path = "/api/internal/git-credentials";

    const res = await app.inject({
      method: "GET",
      url: path,
      headers: makeHmacHeaders(path),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: "ghp_server_token" });
    expect(mockGetGitHubToken).toHaveBeenCalledWith({ server: true });
  });

  it("returns token with valid HMAC signature and taskId", async () => {
    mockGetGitHubToken.mockResolvedValue("ghp_task_token");
    const path = "/api/internal/git-credentials?taskId=task-123";

    const res = await app.inject({
      method: "GET",
      url: path,
      headers: makeHmacHeaders(path),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: "ghp_task_token" });
    expect(mockGetGitHubToken).toHaveBeenCalledWith({ taskId: "task-123" });
  });

  it("returns 401 with expired HMAC signature", async () => {
    const expiredTs = Math.floor(Date.now() / 1000) - 400; // beyond 5-min window
    const path = "/api/internal/git-credentials";

    const res = await app.inject({
      method: "GET",
      url: path,
      headers: makeHmacHeaders(path, expiredTs),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Signature expired");
  });

  it("returns 401 with invalid HMAC signature", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/internal/git-credentials",
      headers: {
        "x-optio-signature": `t=${Math.floor(Date.now() / 1000)},sig=bad_signature`,
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid signature");
  });

  it("returns 401 with HMAC signed for different path", async () => {
    const path = "/api/internal/git-credentials";
    const wrongPath = "/api/internal/other";

    const res = await app.inject({
      method: "GET",
      url: path,
      headers: makeHmacHeaders(wrongPath),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Invalid signature");
  });

  // --- Legacy Bearer token auth (opt-in compatibility) ---

  it("returns 401 when no auth headers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/internal/git-credentials",
    });

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when incorrect bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/internal/git-credentials",
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("Legacy bearer authentication disabled");
  });

  it("returns token with valid legacy bearer only when explicitly enabled", async () => {
    process.env.OPTIO_ALLOW_LEGACY_INTERNAL_BEARER = "1";
    mockGetGitHubToken.mockResolvedValue("ghp_task_token");

    const res = await app.inject({
      method: "GET",
      url: "/api/internal/git-credentials?taskId=task-123",
      headers: { authorization: VALID_BEARER },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: "ghp_task_token" });
    expect(mockGetGitHubToken).toHaveBeenCalledWith({ taskId: "task-123" });
  });

  it("returns token with valid HMAC and no taskId", async () => {
    mockGetGitHubToken.mockResolvedValue("ghp_server_token");
    const path = "/api/internal/git-credentials";

    const res = await app.inject({
      method: "GET",
      url: path,
      headers: makeHmacHeaders(path),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: "ghp_server_token" });
    expect(mockGetGitHubToken).toHaveBeenCalledWith({ server: true });
  });

  // --- Error handling ---

  it("returns 500 when token service throws", async () => {
    mockGetGitHubToken.mockRejectedValue(new Error("Token fetch failed"));
    const path = "/api/internal/git-credentials";

    const res = await app.inject({
      method: "GET",
      url: path,
      headers: makeHmacHeaders(path),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Failed to retrieve git credentials");
  });
});

describe("GET /api/github-app/status", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns configured status when GitHub App is configured", async () => {
    mockIsGitHubAppConfigured.mockReturnValue(true);
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    const res = await app.inject({
      method: "GET",
      url: "/api/github-app/status",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: true,
      appId: "12345",
      installationId: "67890",
    });

    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
  });

  it("returns not configured when GitHub App is not configured", async () => {
    mockIsGitHubAppConfigured.mockReturnValue(false);

    const res = await app.inject({
      method: "GET",
      url: "/api/github-app/status",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false });
  });
});
