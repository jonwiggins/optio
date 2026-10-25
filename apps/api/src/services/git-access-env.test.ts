import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsGitHubAppConfigured = vi.fn();

vi.mock("./github-app-service.js", () => ({
  getInstallationToken: vi.fn(),
  isGitHubAppConfigured: (...args: unknown[]) => mockIsGitHubAppConfigured(...args),
}));

const mockRetrieveSecretWithFallback = vi.fn();
vi.mock("./secret-service.js", () => ({
  retrieveSecretWithFallback: (...args: unknown[]) => mockRetrieveSecretWithFallback(...args),
}));

import { applyGitAccess, requiredGitTokenSecret } from "./git-access-env.js";
import { parseGitCredentialScope } from "./git-credential-scope.js";

describe("requiredGitTokenSecret", () => {
  beforeEach(() => {
    mockIsGitHubAppConfigured.mockReset();
  });

  it("requires GitLab's token for a GitLab repo, GitHub App or not", () => {
    mockIsGitHubAppConfigured.mockReturnValue(false);
    expect(requiredGitTokenSecret("gitlab")).toBe("GITLAB_TOKEN");
    mockIsGitHubAppConfigured.mockReturnValue(true);
    expect(requiredGitTokenSecret("gitlab")).toBe("GITLAB_TOKEN");
  });

  it("requires GitHub's token for a GitHub repo without a GitHub App", () => {
    mockIsGitHubAppConfigured.mockReturnValue(false);
    expect(requiredGitTokenSecret("github")).toBe("GITHUB_TOKEN");
    expect(requiredGitTokenSecret(undefined)).toBe("GITHUB_TOKEN");
  });

  it("requires none when a GitHub App mints installation tokens", () => {
    mockIsGitHubAppConfigured.mockReturnValue(true);
    expect(requiredGitTokenSecret("github")).toBeNull();
  });
});

describe("requiredGitTokenSecret with OPTIO_GIT_PLATFORMS=gitlab", () => {
  it("is always GitLab's token — never GitHub's, GitHub App or not", () => {
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    try {
      for (const app of [false, true]) {
        mockIsGitHubAppConfigured.mockReturnValue(app);
        expect(requiredGitTokenSecret("github")).toBe("GITLAB_TOKEN");
        expect(requiredGitTokenSecret(undefined)).toBe("GITLAB_TOKEN");
        expect(requiredGitTokenSecret("gitlab")).toBe("GITLAB_TOKEN");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("applyGitAccess: the credential helper's scope", () => {
  const ws = "00000000-0000-4000-8000-000000000001";
  const creator = "00000000-0000-4000-8000-000000000002";
  const team = "00000000-0000-4000-8000-000000000003";

  beforeEach(() => {
    vi.stubEnv("OPTIO_ENCRYPTION_KEY", "unit-test-scope-key");
    mockIsGitHubAppConfigured.mockReturnValue(false);
    mockRetrieveSecretWithFallback.mockReset().mockRejectedValue(new Error("not found"));
  });

  const scopeOf = (env: Record<string, string>) =>
    parseGitCredentialScope(new URL(env.OPTIO_GIT_CREDENTIAL_URL).searchParams.get("scope")!);

  it("a team's work names the team, not its creator", async () => {
    const env: Record<string, string> = {};
    await applyGitAccess(env, { workspaceId: ws, ownerUserId: creator, ownerTeamId: team });
    expect(scopeOf(env)).toEqual({ workspaceId: ws, ownerUserId: null, ownerTeamId: team });
    // Its tokens: the team's, else the organization's (secret-service.ts).
    expect(mockRetrieveSecretWithFallback).toHaveBeenCalledWith(
      "GITLAB_TOKEN",
      "global",
      ws,
      creator,
      team,
    );
  });

  it("a person's work keeps the scope's old shape", async () => {
    const env: Record<string, string> = {};
    await applyGitAccess(env, { workspaceId: ws, ownerUserId: creator, runId: "run-1" });
    expect(scopeOf(env)).toEqual({ workspaceId: ws, ownerUserId: creator });
    expect(env.OPTIO_GIT_TASK_CREDENTIAL_URL).toBe(env.OPTIO_GIT_CREDENTIAL_URL);
  });
});
