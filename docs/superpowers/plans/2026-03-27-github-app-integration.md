# GitHub App Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate GitHub OAuth App and manual PAT with a single GitHub App that provides user-scoped tokens for git/API operations and installation tokens for server-side background work.

**Architecture:** A single GitHub App serves two token types. User access tokens (obtained during OAuth login) are stored encrypted and used for all user-initiated operations including agent pod git/API operations via a credential helper. Installation tokens (generated server-side via JWT) are used for background workers (PR watcher, ticket sync). A unified `getGitHubToken(context)` function resolves the right token for each caller. Google/GitLab login flows remain unchanged; those users fall back to a manually-configured `GITHUB_TOKEN` PAT.

**Tech Stack:** Fastify, Drizzle (PostgreSQL), `node:crypto` (RSA-SHA256 JWT signing, AES-256-GCM secret encryption), GitHub REST API v3, BullMQ workers, Bash credential helper scripts.

---

## File Structure

| Action | Path                                                 | Responsibility                                                                              |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Create | `apps/api/src/services/github-app-service.ts`        | Installation token generation (JWT signing, caching) for server-side operations             |
| Create | `apps/api/src/services/github-token-service.ts`      | Unified `getGitHubToken(context)` resolver — user tokens, installation tokens, PAT fallback |
| Create | `apps/api/src/services/github-token-service.test.ts` | Tests for token resolution, user token refresh, installation token generation               |
| Create | `apps/api/src/routes/github-app.ts`                  | Internal credential endpoint (`/api/internal/git-credentials`) and app status endpoint      |
| Create | `apps/api/src/routes/github-app.test.ts`             | Tests for credential and status endpoints                                                   |
| Create | `scripts/optio-git-credential`                       | Git credential helper script for pods                                                       |
| Create | `scripts/optio-gh-wrapper`                           | gh CLI wrapper script for pods                                                              |
| Modify | `apps/api/src/services/oauth/github.ts`              | Switch from OAuth App to GitHub App client credentials, store user tokens                   |
| Modify | `apps/api/src/routes/auth.ts`                        | Store user GitHub tokens on login callback                                                  |
| Modify | `apps/api/src/plugins/auth.ts`                       | Add `/api/internal/` to public routes                                                       |
| Modify | `apps/api/src/server.ts`                             | Register github-app routes                                                                  |
| Modify | `apps/api/src/workers/pr-watcher-worker.ts`          | Use `getGitHubToken({ server: true })`                                                      |
| Modify | `apps/api/src/routes/issues.ts`                      | Use `getGitHubToken({ userId })`                                                            |
| Modify | `apps/api/src/routes/repos.ts`                       | Use `getGitHubToken({ userId })`                                                            |
| Modify | `apps/api/src/workers/task-worker.ts`                | Inject `OPTIO_GIT_CREDENTIAL_URL` into pod env                                              |
| Modify | `scripts/repo-init.sh`                               | Support dynamic credential helper alongside static PAT fallback                             |
| Modify | `images/base.Dockerfile`                             | Copy credential helper scripts into agent image                                             |
| Modify | `helm/optio/values.yaml`                             | Add GitHub App configuration values                                                         |
| Modify | `helm/optio/templates/secrets.yaml`                  | Add GitHub App env vars to K8s secret                                                       |
| Modify | `packages/shared/src/error-classifier.ts`            | Add GitHub access revocation error pattern                                                  |

---

### Task 1: GitHub App Service (Installation Tokens)

**Files:**

- Create: `apps/api/src/services/github-app-service.ts`
- Test: `apps/api/src/services/github-token-service.test.ts` (installation token tests only)

This service handles installation token generation for server-side background operations (PR watcher, ticket sync). It signs RS256 JWTs using the app's private key and exchanges them for short-lived installation tokens via the GitHub API.

- [ ] **Step 1: Write the failing tests for installation token generation**

Create `apps/api/src/services/github-token-service.test.ts` with the installation token tests:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

// Generate a test RSA key pair
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("github-app-service", () => {
  let generateJwt: typeof import("./github-app-service.js").generateJwt;
  let getInstallationToken: typeof import("./github-app-service.js").getInstallationToken;
  let isGitHubAppConfigured: typeof import("./github-app-service.js").isGitHubAppConfigured;
  let resetTokenCache: typeof import("./github-app-service.js").resetTokenCache;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();

    vi.stubEnv("GITHUB_APP_ID", "12345");
    vi.stubEnv("GITHUB_APP_INSTALLATION_ID", "67890");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", TEST_PRIVATE_KEY);

    // Re-import to pick up fresh env vars
    vi.resetModules();
    const mod = await import("./github-app-service.js");
    generateJwt = mod.generateJwt;
    getInstallationToken = mod.getInstallationToken;
    isGitHubAppConfigured = mod.isGitHubAppConfigured;
    resetTokenCache = mod.resetTokenCache;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("isGitHubAppConfigured", () => {
    it("returns true when all three env vars are set", () => {
      expect(isGitHubAppConfigured()).toBe(true);
    });

    it("returns false when GITHUB_APP_ID is missing", async () => {
      vi.stubEnv("GITHUB_APP_ID", "");
      vi.resetModules();
      const mod = await import("./github-app-service.js");
      expect(mod.isGitHubAppConfigured()).toBe(false);
    });

    it("returns false when GITHUB_APP_PRIVATE_KEY is missing", async () => {
      vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
      vi.resetModules();
      const mod = await import("./github-app-service.js");
      expect(mod.isGitHubAppConfigured()).toBe(false);
    });
  });

  describe("generateJwt", () => {
    it("produces a valid RS256 JWT with correct claims", () => {
      const jwt = generateJwt();
      const parts = jwt.split(".");
      expect(parts).toHaveLength(3);

      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });

      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      expect(payload.iss).toBe("12345");
      expect(payload.exp).toBeGreaterThan(payload.iat);
      // iat should be now - 60s (clock skew), exp should be iat + 10min
      expect(payload.exp - payload.iat).toBeLessThanOrEqual(660);
    });
  });

  describe("getInstallationToken", () => {
    it("returns a fresh token on first call", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_test_token_123",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
      });

      const token = await getInstallationToken();
      expect(token).toBe("ghs_test_token_123");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/app/installations/67890/access_tokens",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("returns cached token on second call within 50 minutes", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_cached_token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
      });

      const token1 = await getInstallationToken();
      const token2 = await getInstallationToken();
      expect(token1).toBe("ghs_cached_token");
      expect(token2).toBe("ghs_cached_token");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("refreshes token after cache is reset", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            token: "ghs_first",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            token: "ghs_second",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        });

      const token1 = await getInstallationToken();
      expect(token1).toBe("ghs_first");

      resetTokenCache();

      const token2 = await getInstallationToken();
      expect(token2).toBe("ghs_second");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("throws when GitHub API returns an error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      await expect(getInstallationToken()).rejects.toThrow(
        "Failed to get installation token: 401 Unauthorized",
      );
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/github-token-service.test.ts`
Expected: FAIL — module `./github-app-service.js` does not exist.

- [ ] **Step 3: Write the github-app-service implementation**

Create `apps/api/src/services/github-app-service.ts`:

```typescript
import { createSign } from "node:crypto";

let cachedToken: { token: string; fetchedAt: number } | null = null;

const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes

export function isGitHubAppConfigured(): boolean {
  return !!(
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_INSTALLATION_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY
  );
}

export function generateJwt(): string {
  const appId = process.env.GITHUB_APP_ID!;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY!;

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: appId,
      iat: now - 60, // Clock skew tolerance
      exp: now + 600, // 10 minutes
    }),
  ).toString("base64url");

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

export async function getInstallationToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return cachedToken.token;
  }

  const installationId = process.env.GITHUB_APP_INSTALLATION_ID!;
  const jwt = generateJwt();

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Optio",
      },
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to get installation token: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  cachedToken = { token: data.token, fetchedAt: Date.now() };
  return data.token;
}

export function resetTokenCache(): void {
  cachedToken = null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/github-token-service.test.ts`
Expected: All `github-app-service` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/github-app-service.ts apps/api/src/services/github-token-service.test.ts
git commit -m "feat: add github app service for installation token generation"
```

---

### Task 2: Unified GitHub Token Service

**Files:**

- Create: `apps/api/src/services/github-token-service.ts`
- Modify: `apps/api/src/services/github-token-service.test.ts` (add user token and resolution tests)

The unified token service provides `getGitHubToken(context)` — the single entry point for all GitHub token needs. It resolves user access tokens (with transparent refresh), installation tokens, or PAT fallback depending on the context.

- [ ] **Step 1: Write the failing tests for user token refresh and unified resolution**

Append to `apps/api/src/services/github-token-service.test.ts`:

```typescript
// Add these mocks at the top of the file, after the existing mocks:
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  secrets: {
    id: "secrets.id",
    name: "secrets.name",
    scope: "secrets.scope",
    encryptedValue: "secrets.encrypted_value",
    iv: "secrets.iv",
    authTag: "secrets.auth_tag",
    createdAt: "secrets.created_at",
    updatedAt: "secrets.updated_at",
    workspaceId: "secrets.workspace_id",
  },
  tasks: {
    id: "tasks.id",
    createdBy: "tasks.created_by",
    workspaceId: "tasks.workspace_id",
  },
}));

vi.mock("./secret-service.js", () => ({
  storeSecret: vi.fn(),
  retrieveSecret: vi.fn(),
  retrieveSecretWithFallback: vi.fn(),
  deleteSecret: vi.fn(),
}));

// Add these test suites after the github-app-service describe block:

describe("github-token-service", () => {
  let getGitHubToken: typeof import("./github-token-service.js").getGitHubToken;
  let storeUserGitHubTokens: typeof import("./github-token-service.js").storeUserGitHubTokens;
  let deleteUserGitHubTokens: typeof import("./github-token-service.js").deleteUserGitHubTokens;

  let mockStoreSecret: ReturnType<typeof vi.fn>;
  let mockRetrieveSecret: ReturnType<typeof vi.fn>;
  let mockRetrieveSecretWithFallback: ReturnType<typeof vi.fn>;
  let mockDeleteSecret: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clear GitHub App env vars so installation tokens are not available by default
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_INSTALLATION_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");

    vi.resetModules();

    const secretService = await import("./secret-service.js");
    mockStoreSecret = secretService.storeSecret as ReturnType<typeof vi.fn>;
    mockRetrieveSecret = secretService.retrieveSecret as ReturnType<typeof vi.fn>;
    mockRetrieveSecretWithFallback = secretService.retrieveSecretWithFallback as ReturnType<
      typeof vi.fn
    >;
    mockDeleteSecret = secretService.deleteSecret as ReturnType<typeof vi.fn>;

    const mod = await import("./github-token-service.js");
    getGitHubToken = mod.getGitHubToken;
    storeUserGitHubTokens = mod.storeUserGitHubTokens;
    deleteUserGitHubTokens = mod.deleteUserGitHubTokens;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getGitHubToken with userId context", () => {
    it("returns user access token when available and not expired", async () => {
      const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
      mockRetrieveSecret
        .mockResolvedValueOnce("ghu_valid_token") // GITHUB_USER_ACCESS_TOKEN
        .mockResolvedValueOnce(expiresAt); // GITHUB_USER_TOKEN_EXPIRES_AT

      const token = await getGitHubToken({ userId: "user-123" });
      expect(token).toBe("ghu_valid_token");
    });

    it("refreshes expired user token using refresh token", async () => {
      const expiredAt = new Date(Date.now() - 60000).toISOString(); // expired 1 minute ago
      mockRetrieveSecret
        .mockResolvedValueOnce("ghu_expired_token") // GITHUB_USER_ACCESS_TOKEN
        .mockResolvedValueOnce(expiredAt) // GITHUB_USER_TOKEN_EXPIRES_AT
        .mockResolvedValueOnce("ghr_refresh_token"); // GITHUB_USER_REFRESH_TOKEN

      vi.stubEnv("GITHUB_APP_CLIENT_ID", "test-client-id");
      vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "test-client-secret");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "ghu_refreshed_token",
          refresh_token: "ghr_new_refresh",
          expires_in: 28800,
        }),
      });

      vi.resetModules();
      const mod = await import("./github-token-service.js");

      const token = await mod.getGitHubToken({ userId: "user-123" });
      expect(token).toBe("ghu_refreshed_token");

      // Verify new tokens were stored
      const secretService = await import("./secret-service.js");
      const storeCalls = (secretService.storeSecret as ReturnType<typeof vi.fn>).mock.calls;
      expect(storeCalls).toHaveLength(3); // access token, refresh token, expiry
    });

    it("falls back to PAT when no user tokens exist", async () => {
      mockRetrieveSecret.mockRejectedValue(new Error("Secret not found"));
      mockRetrieveSecretWithFallback.mockResolvedValueOnce("ghp_pat_token");

      const token = await getGitHubToken({ userId: "user-123" });
      expect(token).toBe("ghp_pat_token");
    });

    it("deletes stored tokens and falls back to PAT when refresh fails", async () => {
      const expiredAt = new Date(Date.now() - 60000).toISOString();
      mockRetrieveSecret
        .mockResolvedValueOnce("ghu_expired") // access token
        .mockResolvedValueOnce(expiredAt) // expiry
        .mockResolvedValueOnce("ghr_bad_refresh"); // refresh token

      vi.stubEnv("GITHUB_APP_CLIENT_ID", "test-client-id");
      vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "test-client-secret");

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: "bad_refresh_token" }),
      });

      mockRetrieveSecretWithFallback.mockResolvedValueOnce("ghp_fallback_pat");

      vi.resetModules();
      const mod = await import("./github-token-service.js");

      const token = await mod.getGitHubToken({ userId: "user-123" });
      expect(token).toBe("ghp_fallback_pat");
    });
  });

  describe("getGitHubToken with taskId context", () => {
    it("resolves task creator and returns their token", async () => {
      const { db } = await import("../db/client.js");

      // Mock task lookup: db.select().from().where() chain
      const mockWhere = vi
        .fn()
        .mockResolvedValue([{ createdBy: "user-456", workspaceId: "ws-789" }]);
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      (db.select as ReturnType<typeof vi.fn>).mockReturnValue({ from: mockFrom });

      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      mockRetrieveSecret
        .mockResolvedValueOnce("ghu_task_user_token")
        .mockResolvedValueOnce(expiresAt);

      const token = await getGitHubToken({ taskId: "task-abc" });
      expect(token).toBe("ghu_task_user_token");
    });
  });

  describe("getGitHubToken with server context", () => {
    it("returns installation token when GitHub App is configured", async () => {
      vi.stubEnv("GITHUB_APP_ID", "12345");
      vi.stubEnv("GITHUB_APP_INSTALLATION_ID", "67890");
      vi.stubEnv("GITHUB_APP_PRIVATE_KEY", TEST_PRIVATE_KEY);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ghs_install_token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
      });

      vi.resetModules();
      const mod = await import("./github-token-service.js");
      const token = await mod.getGitHubToken({ server: true });
      expect(token).toBe("ghs_install_token");
    });

    it("falls back to PAT when GitHub App is not configured", async () => {
      mockRetrieveSecretWithFallback.mockResolvedValueOnce("ghp_server_pat");

      const token = await getGitHubToken({ server: true });
      expect(token).toBe("ghp_server_pat");
    });
  });

  describe("storeUserGitHubTokens", () => {
    it("stores access token, refresh token, and expiry as secrets", async () => {
      await storeUserGitHubTokens("user-123", {
        accessToken: "ghu_new",
        refreshToken: "ghr_new",
        expiresIn: 28800,
      });

      expect(mockStoreSecret).toHaveBeenCalledTimes(3);
      expect(mockStoreSecret).toHaveBeenCalledWith(
        "GITHUB_USER_ACCESS_TOKEN",
        "ghu_new",
        "user:user-123",
        undefined,
      );
      expect(mockStoreSecret).toHaveBeenCalledWith(
        "GITHUB_USER_REFRESH_TOKEN",
        "ghr_new",
        "user:user-123",
        undefined,
      );
      expect(mockStoreSecret).toHaveBeenCalledWith(
        "GITHUB_USER_TOKEN_EXPIRES_AT",
        expect.any(String),
        "user:user-123",
        undefined,
      );
    });
  });

  describe("deleteUserGitHubTokens", () => {
    it("deletes all three user token secrets", async () => {
      await deleteUserGitHubTokens("user-123");

      expect(mockDeleteSecret).toHaveBeenCalledTimes(3);
      expect(mockDeleteSecret).toHaveBeenCalledWith("GITHUB_USER_ACCESS_TOKEN", "user:user-123");
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/github-token-service.test.ts`
Expected: FAIL — module `./github-token-service.js` does not exist.

- [ ] **Step 3: Write the github-token-service implementation**

Create `apps/api/src/services/github-token-service.ts`:

```typescript
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import {
  retrieveSecret,
  retrieveSecretWithFallback,
  storeSecret,
  deleteSecret,
} from "./secret-service.js";
import { isGitHubAppConfigured, getInstallationToken } from "./github-app-service.js";

// Per-user mutex to prevent concurrent refresh races
const refreshLocks = new Map<string, Promise<string>>();

const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000; // Refresh 10 minutes before expiry

export type GitHubTokenContext =
  | { taskId: string }
  | { userId: string; workspaceId?: string | null }
  | { server: true };

export async function getGitHubToken(context: GitHubTokenContext): Promise<string> {
  if ("server" in context) {
    return getServerToken();
  }

  if ("taskId" in context) {
    return getTokenForTask(context.taskId);
  }

  return getTokenForUser(context.userId, context.workspaceId);
}

async function getServerToken(): Promise<string> {
  if (isGitHubAppConfigured()) {
    return getInstallationToken();
  }
  return retrieveSecretWithFallback("GITHUB_TOKEN", "global");
}

async function getTokenForTask(taskId: string): Promise<string> {
  const [task] = await db
    .select({ createdBy: tasks.createdBy, workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  if (!task?.createdBy) {
    // No user associated with task — fall back to PAT
    return retrieveSecretWithFallback("GITHUB_TOKEN", "global", task?.workspaceId);
  }

  return getTokenForUser(task.createdBy, task.workspaceId);
}

async function getTokenForUser(userId: string, workspaceId?: string | null): Promise<string> {
  // Try user's stored GitHub App token
  try {
    const accessToken = await retrieveSecret("GITHUB_USER_ACCESS_TOKEN", `user:${userId}`);
    const expiresAt = await retrieveSecret("GITHUB_USER_TOKEN_EXPIRES_AT", `user:${userId}`);

    const expiryTime = new Date(expiresAt).getTime();
    if (Date.now() < expiryTime - TOKEN_REFRESH_BUFFER_MS) {
      return accessToken;
    }

    // Token expired or near expiry — refresh it
    return refreshUserToken(userId);
  } catch {
    // No user tokens stored — fall back to PAT
    return retrieveSecretWithFallback("GITHUB_TOKEN", "global", workspaceId);
  }
}

async function refreshUserToken(userId: string): Promise<string> {
  // Prevent concurrent refreshes for the same user
  const existing = refreshLocks.get(userId);
  if (existing) {
    return existing;
  }

  const refreshPromise = doRefreshUserToken(userId);
  refreshLocks.set(userId, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    refreshLocks.delete(userId);
  }
}

async function doRefreshUserToken(userId: string): Promise<string> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    // Can't refresh without client credentials — delete stale tokens, fall back to PAT
    await deleteUserGitHubTokens(userId);
    return retrieveSecretWithFallback("GITHUB_TOKEN", "global");
  }

  try {
    const refreshToken = await retrieveSecret("GITHUB_USER_REFRESH_TOKEN", `user:${userId}`);

    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      throw new Error(`GitHub token refresh failed: ${res.status}`);
    }

    const data = (await res.json()) as Record<string, string | number>;

    if (data.error) {
      throw new Error(`GitHub token refresh error: ${data.error}`);
    }

    const newAccessToken = data.access_token as string;
    const newRefreshToken = data.refresh_token as string;
    const expiresIn = (data.expires_in as number) || 28800;

    await storeUserGitHubTokens(userId, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn,
    });

    return newAccessToken;
  } catch {
    // Refresh failed (revoked, expired after 6 months, etc.)
    await deleteUserGitHubTokens(userId);
    return retrieveSecretWithFallback("GITHUB_TOKEN", "global");
  }
}

export async function storeUserGitHubTokens(
  userId: string,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
): Promise<void> {
  const scope = `user:${userId}`;
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();

  await Promise.all([
    storeSecret("GITHUB_USER_ACCESS_TOKEN", tokens.accessToken, scope),
    storeSecret("GITHUB_USER_REFRESH_TOKEN", tokens.refreshToken, scope),
    storeSecret("GITHUB_USER_TOKEN_EXPIRES_AT", expiresAt, scope),
  ]);
}

export async function deleteUserGitHubTokens(userId: string): Promise<void> {
  const scope = `user:${userId}`;
  await Promise.all([
    deleteSecret("GITHUB_USER_ACCESS_TOKEN", scope),
    deleteSecret("GITHUB_USER_REFRESH_TOKEN", scope),
    deleteSecret("GITHUB_USER_TOKEN_EXPIRES_AT", scope),
  ]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/github-token-service.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `cd apps/api && npx vitest run`
Expected: All existing tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/github-token-service.ts apps/api/src/services/github-token-service.test.ts
git commit -m "feat: add unified github token service with user token refresh"
```

---

### Task 3: GitHub OAuth Provider — Switch to GitHub App

**Files:**

- Modify: `apps/api/src/services/oauth/github.ts`
- Modify: `apps/api/src/routes/auth.ts`

The GitHub OAuth provider switches from reading `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` (OAuth App) to `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` (GitHub App). The authorize URL drops explicit scopes (GitHub App permissions are configured on the app registration). The auth callback stores user access and refresh tokens after login.

- [ ] **Step 1: Update the GitHub OAuth provider to use GitHub App credentials**

Modify `apps/api/src/services/oauth/github.ts`. Replace the entire file:

```typescript
import type { OAuthProvider, OAuthTokens, OAuthUser } from "./provider.js";
import { getCallbackUrl } from "./provider.js";

export class GitHubOAuthProvider implements OAuthProvider {
  name = "github";

  private get clientId(): string {
    // Prefer GitHub App client ID, fall back to legacy OAuth App client ID
    return process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_OAUTH_CLIENT_ID ?? "";
  }

  private get clientSecret(): string {
    return process.env.GITHUB_APP_CLIENT_SECRET ?? process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "";
  }

  private get isGitHubApp(): boolean {
    return !!(process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET);
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: getCallbackUrl("github"),
      state,
    });
    // GitHub App: permissions are set on the app registration, no scopes needed.
    // Legacy OAuth App: request user profile scopes explicitly.
    if (!this.isGitHubApp) {
      params.set("scope", "read:user user:email");
    }
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: getCallbackUrl("github"),
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub token exchange failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as Record<string, string | number>;
    if (data.error) {
      throw new Error(`GitHub OAuth error: ${(data.error_description as string) ?? data.error}`);
    }
    return {
      accessToken: data.access_token as string,
      refreshToken: data.refresh_token as string | undefined,
      expiresIn: (data.expires_in as number | undefined) ?? undefined,
    };
  }

  async fetchUser(accessToken: string): Promise<OAuthUser> {
    const [userRes, emailsRes] = await Promise.all([
      fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      }),
      fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      }),
    ]);

    if (!userRes.ok) {
      throw new Error(`GitHub user fetch failed: ${userRes.status} ${userRes.statusText}`);
    }
    if (!emailsRes.ok) {
      throw new Error(`GitHub emails fetch failed: ${emailsRes.status} ${emailsRes.statusText}`);
    }
    const user = (await userRes.json()) as Record<string, any>;
    const emails = (await emailsRes.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;

    const primaryEmail =
      emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? "";

    return {
      externalId: String(user.id),
      email: primaryEmail || user.email || "",
      displayName: user.name || user.login || "",
      avatarUrl: user.avatar_url,
    };
  }
}
```

- [ ] **Step 2: Update the OAuthTokens interface to include expiresIn**

Modify `apps/api/src/services/oauth/provider.ts`. Update the `OAuthTokens` interface:

```typescript
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}
```

- [ ] **Step 3: Update the auth callback to store user GitHub tokens**

Modify `apps/api/src/routes/auth.ts`. Add the import at the top of the file, after the existing imports:

```typescript
import { storeUserGitHubTokens } from "../services/github-token-service.js";
```

Then modify the callback handler (around line 193-201). Replace the try block contents:

```typescript
try {
  const tokens = await provider.exchangeCode(code);
  const profile = await provider.fetchUser(tokens.accessToken);
  const { token, user } = await createSession(providerName, profile);

  // Store GitHub App user tokens for git/API operations
  if (providerName === "github" && tokens.refreshToken && tokens.expiresIn) {
    await storeUserGitHubTokens(user.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    });
  }

  // Redirect to web app with a short-lived exchange code.
  // The web app exchanges it for the session token and sets its own cookie.
  const authCode = createAuthCode(token);
  reply.redirect(`${WEB_URL}/auth/callback?code=${authCode}`);
} catch (err) {
  app.log.error(err, "OAuth callback failed");
  reply.redirect(`${WEB_URL}/login?error=auth_failed`);
}
```

- [ ] **Step 4: Update createSession to return the user object**

Modify `apps/api/src/services/session-service.ts`. The `createSession` function currently returns `{ token, user: SessionUser }` — verify it returns the user `id`. Check line 24 onwards: `createSession` returns `{ token, ...user }` as a `SessionUser`. We need the user's `id` to store tokens.

The `SessionUser` interface already includes `id`. The auth callback currently destructures as `const { token } = await createSession(...)`. The change in Step 3 destructures `{ token, user }` instead, where `user` is the full return minus `token`. Update the destructuring:

Actually, looking at `createSession` (session-service.ts line 24), it returns `{ token: string } & SessionUser` where `SessionUser` has `id`. So we need:

```typescript
const sessionResult = await createSession(providerName, profile);
const { token, ...user } = sessionResult;
// or simply:
const result = await createSession(providerName, profile);
```

Revise the callback in Step 3 to:

```typescript
try {
  const tokens = await provider.exchangeCode(code);
  const profile = await provider.fetchUser(tokens.accessToken);
  const session = await createSession(providerName, profile);

  // Store GitHub App user tokens for git/API operations
  if (providerName === "github" && tokens.refreshToken && tokens.expiresIn) {
    await storeUserGitHubTokens(session.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    });
  }

  const authCode = createAuthCode(session.token);
  reply.redirect(`${WEB_URL}/auth/callback?code=${authCode}`);
} catch (err) {
  app.log.error(err, "OAuth callback failed");
  reply.redirect(`${WEB_URL}/login?error=auth_failed`);
}
```

Wait — `createSession` returns `{ token: string } & SessionUser`. `SessionUser.id` is the **user** id. But `session.token` is the session token, and `session.id` is the user id. Let me re-read the code. Looking at `session-service.ts`:

```typescript
return {
  token,
  id: userId,
  provider,
  email,
  displayName,
  avatarUrl,
  workspaceId,
  workspaceRole: null,
};
```

So `session.id` = user ID and `session.token` = session token. The Step 3 code is correct.

- [ ] **Step 5: Run typecheck**

Run: `pnpm turbo typecheck`
Expected: PASS. If the `expiresIn` field on `OAuthTokens` causes issues in other providers, verify Google/GitLab providers don't break (they already return `{ accessToken, refreshToken }` — the optional `expiresIn` is additive).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/oauth/github.ts apps/api/src/services/oauth/provider.ts apps/api/src/routes/auth.ts
git commit -m "feat: switch github oauth to github app with user token storage"
```

---

### Task 4: Internal Credential Endpoint

**Files:**

- Create: `apps/api/src/routes/github-app.ts`
- Create: `apps/api/src/routes/github-app.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/plugins/auth.ts`

The credential endpoint serves GitHub tokens to agent pods. The pod's credential helper calls `GET /api/internal/git-credentials?taskId=xxx` and receives the task creator's token. A status endpoint lets the UI check if a GitHub App is configured.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/github-app.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../services/github-token-service.js", () => ({
  getGitHubToken: vi.fn(),
}));

vi.mock("../services/github-app-service.js", () => ({
  isGitHubAppConfigured: vi.fn(),
}));

describe("github-app routes", () => {
  let getGitHubToken: ReturnType<typeof vi.fn>;
  let isGitHubAppConfigured: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const tokenService = await import("../services/github-token-service.js");
    const appService = await import("../services/github-app-service.js");
    getGitHubToken = tokenService.getGitHubToken as ReturnType<typeof vi.fn>;
    isGitHubAppConfigured = appService.isGitHubAppConfigured as ReturnType<typeof vi.fn>;
  });

  describe("GET /api/internal/git-credentials", () => {
    it("returns token when taskId is provided and token is available", async () => {
      getGitHubToken.mockResolvedValueOnce("ghu_test_token");

      // Import the route handler and test directly
      const { buildCredentialResponse } = await import("./github-app.js");
      const result = await buildCredentialResponse("task-123");

      expect(result).toEqual({ token: "ghu_test_token" });
      expect(getGitHubToken).toHaveBeenCalledWith({ taskId: "task-123" });
    });

    it("throws when no token is available", async () => {
      getGitHubToken.mockRejectedValueOnce(new Error("No token"));

      const { buildCredentialResponse } = await import("./github-app.js");
      await expect(buildCredentialResponse("task-123")).rejects.toThrow();
    });
  });

  describe("GET /api/github-app/status", () => {
    it("returns configured: true when GitHub App is set up", async () => {
      isGitHubAppConfigured.mockReturnValue(true);
      vi.stubEnv("GITHUB_APP_ID", "12345");
      vi.stubEnv("GITHUB_APP_INSTALLATION_ID", "67890");

      const { buildStatusResponse } = await import("./github-app.js");
      const result = buildStatusResponse();

      expect(result).toEqual({
        configured: true,
        appId: "12345",
        installationId: "67890",
      });
    });

    it("returns configured: false when GitHub App is not set up", async () => {
      isGitHubAppConfigured.mockReturnValue(false);

      const { buildStatusResponse } = await import("./github-app.js");
      const result = buildStatusResponse();

      expect(result).toEqual({ configured: false });
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/github-app.test.ts`
Expected: FAIL — module `./github-app.js` does not exist.

- [ ] **Step 3: Write the route implementation**

Create `apps/api/src/routes/github-app.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { getGitHubToken } from "../services/github-token-service.js";
import { isGitHubAppConfigured } from "../services/github-app-service.js";

// Exported for testing
export async function buildCredentialResponse(taskId: string): Promise<{ token: string }> {
  const token = await getGitHubToken({ taskId });
  return { token };
}

export function buildStatusResponse(): {
  configured: boolean;
  appId?: string;
  installationId?: string;
} {
  if (!isGitHubAppConfigured()) {
    return { configured: false };
  }
  return {
    configured: true,
    appId: process.env.GITHUB_APP_ID,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
  };
}

export default async function githubAppRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Internal endpoint — called by the credential helper in agent pods.
   * No auth required (added to PUBLIC_ROUTES in auth plugin).
   */
  app.get<{ Querystring: { taskId?: string } }>(
    "/api/internal/git-credentials",
    async (req, reply) => {
      const { taskId } = req.query;
      if (!taskId) {
        return reply.status(400).send({ error: "taskId query parameter is required" });
      }

      try {
        const result = await buildCredentialResponse(taskId);
        return reply.send(result);
      } catch (err) {
        app.log.error(err, "Failed to get git credentials for task %s", taskId);
        return reply.status(500).send({ error: "Failed to retrieve git credentials" });
      }
    },
  );

  /** GitHub App configuration status (no secret values returned). */
  app.get("/api/github-app/status", async (_req, reply) => {
    return reply.send(buildStatusResponse());
  });
}
```

- [ ] **Step 4: Add `/api/internal/` to public routes**

Modify `apps/api/src/plugins/auth.ts`. Find the `PUBLIC_ROUTES` array (line 17) and add `/api/internal/`:

```typescript
const PUBLIC_ROUTES = [
  "/api/health",
  "/api/auth/",
  "/api/setup/",
  "/api/webhooks/",
  "/ws/",
  "/api/internal/",
];
```

- [ ] **Step 5: Register the routes in server.ts**

Modify `apps/api/src/server.ts`. Add the import near the top with other route imports:

```typescript
import githubAppRoutes from "./routes/github-app.js";
```

Add route registration after the existing route registrations (around line 93):

```typescript
await app.register(githubAppRoutes);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/github-app.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Run typecheck**

Run: `pnpm turbo typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/github-app.ts apps/api/src/routes/github-app.test.ts apps/api/src/plugins/auth.ts apps/api/src/server.ts
git commit -m "feat: add internal credential endpoint and github app status route"
```

---

### Task 5: Pod Credential Scripts

**Files:**

- Create: `scripts/optio-git-credential`
- Create: `scripts/optio-gh-wrapper`

These scripts run inside agent pods. The git credential helper is called by git on every auth request. The gh wrapper fetches a fresh token before each `gh` CLI invocation.

- [ ] **Step 1: Create the git credential helper**

Create `scripts/optio-git-credential`:

```bash
#!/bin/bash
# Git credential helper — called by git with "get" on stdin.
# Fetches a fresh token from the Optio API using the task-scoped credential endpoint.
while IFS= read -r line; do
  case "$line" in host=*) host="${line#host=}";; esac
  [ -z "$line" ] && break
done
if [ "$host" = "github.com" ]; then
  TOKEN=$(curl -sf "${OPTIO_GIT_CREDENTIAL_URL}" | jq -r '.token')
  if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
    echo "protocol=https"
    echo "host=github.com"
    echo "username=x-access-token"
    echo "password=${TOKEN}"
  fi
fi
```

- [ ] **Step 2: Create the gh CLI wrapper**

Create `scripts/optio-gh-wrapper`:

```bash
#!/bin/bash
# Wrapper for gh CLI — fetches a fresh GitHub token before each invocation.
export GITHUB_TOKEN=$(curl -sf "${OPTIO_GIT_CREDENTIAL_URL}" | jq -r '.token')
exec /usr/bin/gh-real "$@"
```

- [ ] **Step 3: Make both scripts executable**

Run: `chmod +x scripts/optio-git-credential scripts/optio-gh-wrapper`

- [ ] **Step 4: Commit**

```bash
git add scripts/optio-git-credential scripts/optio-gh-wrapper
git commit -m "feat: add credential helper and gh wrapper scripts for agent pods"
```

---

### Task 6: Agent Image Updates

**Files:**

- Modify: `images/base.Dockerfile`

Copy the credential helper scripts into the agent image. All preset images (node, python, go, rust, full) inherit from base and get these automatically.

- [ ] **Step 1: Add credential helper scripts to the Dockerfile**

Modify `images/base.Dockerfile`. Add after the existing `COPY scripts/` lines (after line 38, before the non-root user setup):

```dockerfile
# Optio credential helpers for dynamic GitHub token refresh
COPY scripts/optio-git-credential /usr/local/bin/optio-git-credential
COPY scripts/optio-gh-wrapper /usr/local/bin/optio-gh-wrapper
RUN chmod +x /usr/local/bin/optio-git-credential /usr/local/bin/optio-gh-wrapper
```

- [ ] **Step 2: Verify the Dockerfile is valid**

Run: `docker build --check -f images/base.Dockerfile .` (or just verify syntax by reading it back).

- [ ] **Step 3: Commit**

```bash
git add images/base.Dockerfile
git commit -m "feat: add credential helper scripts to agent base image"
```

---

### Task 7: Pod Init and Task Worker Integration

**Files:**

- Modify: `scripts/repo-init.sh`
- Modify: `apps/api/src/workers/task-worker.ts`

Update pod initialization to use the dynamic credential helper when `OPTIO_GIT_CREDENTIAL_URL` is set, falling back to the existing static `GITHUB_TOKEN` behavior. Update the task worker to inject the credential URL into pod env vars.

- [ ] **Step 1: Update repo-init.sh to support dynamic credentials**

Modify `scripts/repo-init.sh`. Replace lines 11-21 (the `GITHUB_TOKEN` block) with:

```bash
# Set up GitHub credentials
if [ -n "${OPTIO_GIT_CREDENTIAL_URL:-}" ]; then
  # Dynamic credential helper — always-fresh tokens from Optio API
  git config --global credential.helper '/usr/local/bin/optio-git-credential'
  echo "[optio] Dynamic git credential helper configured"

  # Set up gh CLI wrapper for dynamic token refresh
  if [ -f /usr/bin/gh ] && [ -f /usr/local/bin/optio-gh-wrapper ]; then
    mv /usr/bin/gh /usr/bin/gh-real
    ln -s /usr/local/bin/optio-gh-wrapper /usr/bin/gh
    echo "[optio] gh CLI wrapper configured"
  fi

  # Verify connectivity
  if curl -sf "${OPTIO_GIT_CREDENTIAL_URL}" > /dev/null 2>&1; then
    echo "[optio] Credential service reachable"
  else
    echo "[optio] WARNING: Credential service not reachable at ${OPTIO_GIT_CREDENTIAL_URL}"
  fi
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  # Fallback: static PAT (existing behavior)
  git config --global credential.helper store
  echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
  chmod 600 ~/.git-credentials
  echo "[optio] Git credentials configured (static token)"

  echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
  echo "[optio] GitHub CLI configured"
fi
```

- [ ] **Step 2: Update the task worker to inject the credential URL**

Modify `apps/api/src/workers/task-worker.ts`. Add import at the top:

```typescript
import { isGitHubAppConfigured } from "../services/github-app-service.js";
```

After the `resolvedSecrets` are merged into `allEnv` (around line 282), add:

```typescript
// Inject dynamic credential URL for pod git/gh operations
const credentialUrl = `http://${process.env.API_HOST ?? "optio-api"}:${process.env.API_PORT ?? "4000"}/api/internal/git-credentials?taskId=${task.id}`;
allEnv.OPTIO_GIT_CREDENTIAL_URL = credentialUrl;

// Only inject static GITHUB_TOKEN when GitHub App is not configured
// and the credential helper scripts may not be available (old images)
if (isGitHubAppConfigured() && allEnv.GITHUB_TOKEN) {
  delete allEnv.GITHUB_TOKEN;
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm turbo typecheck`
Expected: PASS.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run`
Expected: All tests PASS. If task-worker tests fail due to the new import, update the mock setup in `task-worker.test.ts` to mock `github-app-service.js`.

- [ ] **Step 5: Commit**

```bash
git add scripts/repo-init.sh apps/api/src/workers/task-worker.ts
git commit -m "feat: integrate dynamic credential helper into pod init and task worker"
```

---

### Task 8: Migrate Existing GitHub Token Consumers

**Files:**

- Modify: `apps/api/src/workers/pr-watcher-worker.ts`
- Modify: `apps/api/src/routes/issues.ts`
- Modify: `apps/api/src/routes/repos.ts`

Replace all direct `retrieveSecret("GITHUB_TOKEN")` calls with `getGitHubToken()` using the appropriate context.

- [ ] **Step 1: Update pr-watcher-worker.ts**

Modify `apps/api/src/workers/pr-watcher-worker.ts`.

Add import:

```typescript
import { getGitHubToken } from "../services/github-token-service.js";
```

Replace the `getGithubToken` function (around line 152-164) that uses `retrieveSecretWithFallback` with:

```typescript
const getGithubToken = async (workspaceId: string | null): Promise<string | null> => {
  const cacheKey = workspaceId ?? "__global__";
  if (tokenCache.has(cacheKey)) return tokenCache.get(cacheKey)!;
  try {
    const token = await getGitHubToken({ server: true });
    tokenCache.set(cacheKey, token);
    return token;
  } catch {
    tokenCache.set(cacheKey, null);
    return null;
  }
};
```

Remove the now-unused import of `retrieveSecretWithFallback` from `secret-service.js` if it was only used here.

- [ ] **Step 2: Update routes/issues.ts**

Modify `apps/api/src/routes/issues.ts`.

Add import:

```typescript
import { getGitHubToken } from "../services/github-token-service.js";
```

Replace `retrieveSecret("GITHUB_TOKEN")` calls (around lines 15 and 149) with:

```typescript
const githubToken = await getGitHubToken({ userId: req.user!.id }).catch(() => null);
```

Remove the now-unused import of `retrieveSecret` from `secret-service.js` if it was only used here.

- [ ] **Step 3: Update routes/repos.ts**

Modify `apps/api/src/routes/repos.ts`.

Add import:

```typescript
import { getGitHubToken } from "../services/github-token-service.js";
```

Replace `retrieveSecret("GITHUB_TOKEN").catch(() => null)` (around line 73) with:

```typescript
const githubToken = await getGitHubToken({ userId: req.user!.id }).catch(() => null);
```

Replace `retrieveSecret("GITHUB_TOKEN")` (around line 127) with:

```typescript
const githubToken = await getGitHubToken({ userId: req.user!.id });
```

Remove the now-unused import of `retrieveSecret` from `secret-service.js` if it was only used here.

- [ ] **Step 4: Run typecheck**

Run: `pnpm turbo typecheck`
Expected: PASS.

- [ ] **Step 5: Run tests**

Run: `cd apps/api && npx vitest run`
Expected: All tests PASS. If pr-watcher-worker tests fail, update the mock in `pr-watcher-worker.test.ts` to mock `github-token-service.js` instead of `secret-service.js` for the GITHUB_TOKEN retrieval.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/workers/pr-watcher-worker.ts apps/api/src/routes/issues.ts apps/api/src/routes/repos.ts
git commit -m "refactor: migrate github token consumers to unified token service"
```

---

### Task 9: Helm Chart Configuration

**Files:**

- Modify: `helm/optio/values.yaml`
- Modify: `helm/optio/templates/secrets.yaml`

Add GitHub App configuration values to the Helm chart. The existing `auth.github` block handles the legacy OAuth App; a new `github.app` block handles the GitHub App credentials.

- [ ] **Step 1: Add GitHub App values**

Modify `helm/optio/values.yaml`. Add after the `webhook` block (around line 137), before the `encryption` block:

```yaml
# GitHub App (recommended — replaces OAuth App + PAT for GitHub operations)
# Register at https://github.com/organizations/{org}/settings/apps
# Required permissions: Contents R/W, Pull Requests R/W, Issues R/W, Checks R, Metadata R
github:
  app:
    id: "" # App ID (integer, from app settings page)
    clientId: "" # Client ID (for user OAuth login flow)
    clientSecret: "" # Client secret (for user OAuth login flow)
    installationId: "" # Installation ID (from org install URL or API)
    privateKey: "" # PEM private key (for server-side installation tokens)
```

- [ ] **Step 2: Add GitHub App secrets to the template**

Modify `helm/optio/templates/secrets.yaml`. Add after the GitLab OAuth block (around line 31), before the webhook block:

```yaml
  {{- if .Values.github.app.id }}
  GITHUB_APP_ID: {{ .Values.github.app.id | quote }}
  GITHUB_APP_CLIENT_ID: {{ .Values.github.app.clientId | quote }}
  GITHUB_APP_CLIENT_SECRET: {{ .Values.github.app.clientSecret | quote }}
  GITHUB_APP_INSTALLATION_ID: {{ .Values.github.app.installationId | quote }}
  GITHUB_APP_PRIVATE_KEY: {{ .Values.github.app.privateKey | quote }}
  {{- end }}
```

- [ ] **Step 3: Lint the Helm chart**

Run: `helm lint helm/optio --set encryption.key=test --set postgresql.auth.password=test`
Expected: PASS with no errors.

- [ ] **Step 4: Commit**

```bash
git add helm/optio/values.yaml helm/optio/templates/secrets.yaml
git commit -m "feat: add github app configuration to helm chart"
```

---

### Task 10: Error Classifier Updates

**Files:**

- Modify: `packages/shared/src/error-classifier.ts`

Add error patterns for GitHub access revocation and token expiry so failed tasks show actionable messages.

- [ ] **Step 1: Add GitHub-specific error patterns**

Modify `packages/shared/src/error-classifier.ts`. Add these entries to the `ERROR_PATTERNS` array, before the generic network error pattern (around line 159):

```typescript
  {
    pattern: /GitHub access revoked|github.*app.*authorization.*revoked|bad_refresh_token/i,
    classify: () => ({
      category: "auth",
      title: "GitHub access revoked",
      description:
        "The user's GitHub App authorization has been revoked. The agent can no longer access GitHub on their behalf.",
      remedy:
        "The user needs to log in again via GitHub to re-authorize the application. Go to Settings > Applications on GitHub to verify the app is authorized.",
      retryable: false,
    }),
  },
  {
    pattern: /GitHub user token expired|refresh_token.*expired/i,
    classify: () => ({
      category: "auth",
      title: "GitHub token expired",
      description:
        "The user's GitHub refresh token has expired (6-month lifetime). A fresh login is required.",
      remedy: "Log out and log back in via GitHub to obtain a fresh token.",
      retryable: false,
    }),
  },
```

- [ ] **Step 2: Run existing error classifier tests**

Run: `cd packages/shared && npx vitest run`
Expected: All existing tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/error-classifier.ts
git commit -m "feat: add github access revocation error patterns to classifier"
```

---

### Task 11: Web API Client Updates

**Files:**

- Modify: `apps/web/src/lib/api-client.ts`

Add methods for the new GitHub App status endpoint so the UI can check configuration state.

- [ ] **Step 1: Add GitHub App API methods**

Modify `apps/web/src/lib/api-client.ts`. Add to the `api` object, near the existing OAuth/auth methods:

```typescript
  getGitHubAppStatus: () =>
    request<{ configured: boolean; appId?: string; installationId?: string }>(
      "/api/github-app/status",
    ),
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm turbo typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api-client.ts
git commit -m "feat: add github app status method to web api client"
```

---

### Task 12: Final Integration Test

**Files:** (no new files — verification only)

Run the full quality suite to verify nothing is broken.

- [ ] **Step 1: Run formatting check**

Run: `pnpm format:check`
Expected: PASS. If any files have formatting issues, run `pnpm format` to fix them.

- [ ] **Step 2: Run typecheck across all packages**

Run: `pnpm turbo typecheck`
Expected: PASS across all 6 packages.

- [ ] **Step 3: Run all tests**

Run: `pnpm turbo test`
Expected: All tests PASS.

- [ ] **Step 4: Verify web build**

Run: `cd apps/web && npx next build`
Expected: PASS — production build succeeds.

- [ ] **Step 5: Lint Helm chart**

Run: `helm lint helm/optio --set encryption.key=test --set postgresql.auth.password=test`
Expected: PASS.

- [ ] **Step 6: Commit any formatting fixes**

If Step 1 required formatting fixes:

```bash
git add -A
git commit -m "chore: format code"
```
