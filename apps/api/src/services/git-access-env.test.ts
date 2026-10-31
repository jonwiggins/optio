vi.mock("./gitlab-instance-service.js", () => ({ refreshGitLabInstances: vi.fn(async () => {}) }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const installationToken = vi.hoisted(() => vi.fn());
vi.mock("./github-app-service.js", () => ({
  isGitHubAppConfigured: () => true,
  getInstallationToken: installationToken,
}));
vi.mock("./secret-service.js", () => ({
  retrieveSecretWithFallback: vi.fn().mockRejectedValue(new Error("none")),
}));

import { applyGitAccess, requiredGitTokenSecret } from "./git-access-env.js";
import { parseGitCredentialScope } from "./git-credential-scope.js";
import { retrieveSecretWithFallback } from "./secret-service.js";

beforeEach(() => {
  vi.stubEnv("OPTIO_ENCRYPTION_KEY", "unit-test-git-access-key");
  installationToken.mockReset().mockResolvedValue("ghs_repo");
  vi.mocked(retrieveSecretWithFallback).mockReset().mockRejectedValue(new Error("none"));
  for (const name of ["GITHUB_HOSTS", "OPTIO_GITHUB_HOSTS", "GITLAB_HOSTS", "OPTIO_GITLAB_HOSTS"]) {
    vi.stubEnv(name, "");
  }
});
afterEach(() => vi.unstubAllEnvs());

describe("applyGitAccess", () => {
  it.each([false, true])(
    "does not provide credentials for an unlisted repo host (helper=%s)",
    async (helper) => {
      const env: Record<string, string> = {
        GITHUB_TOKEN: "resolved-default",
        GITLAB_TOKEN: "resolved-default",
        GITLAB_HOST: "attacker.example",
        OPTIO_GIT_CREDENTIAL_URL: "old-helper",
        OPTIO_GIT_TASK_CREDENTIAL_URL: "old-helper",
        OPTIO_CREDENTIAL_SECRET: "old-key",
        ANTHROPIC_API_KEY: "agent-key",
      };
      await applyGitAccess(env, {
        workspaceId: null,
        repoUrl: "https://attacker.example/o/r",
        helper,
      });
      expect(env).toEqual({ ANTHROPIC_API_KEY: "agent-key" });
      expect(retrieveSecretWithFallback).not.toHaveBeenCalled();
      expect(installationToken).not.toHaveBeenCalled();
    },
  );

  it.each(["gitlab.com", "git.corp.example"])(
    "keeps GitLab credentials for trusted host %s",
    async (host) => {
      vi.stubEnv("GITLAB_HOSTS", "git.corp.example");
      vi.mocked(retrieveSecretWithFallback).mockImplementation(async (name) => {
        if (name === "GITLAB_TOKEN") return "glpat-deployment";
        throw new Error("none");
      });
      const env: Record<string, string> = {};
      await applyGitAccess(env, { workspaceId: null, repoUrl: `https://${host}/acme/app` });
      expect(env.GITLAB_TOKEN).toBe("glpat-deployment");
      expect(env.OPTIO_GIT_CREDENTIAL_URL).toBeTruthy();
    },
  );

  it("gives a turn a token for its own repo only", async () => {
    const env: Record<string, string> = {};
    await applyGitAccess(env, {
      workspaceId: null,
      repoUrl: "https://github.com/acme/widgets.git",
      helper: false,
    });
    expect(installationToken).toHaveBeenCalledWith({ owner: "acme", name: "widgets" });
    expect(env.GITHUB_TOKEN).toBe("ghs_repo");
  });

  it("gives a turn on a non-GitHub repo no GitHub App token", async () => {
    const env: Record<string, string> = {};
    await applyGitAccess(env, {
      workspaceId: null,
      repoUrl: "https://gitlab.com/acme/widgets",
      helper: false,
    });
    expect(installationToken).not.toHaveBeenCalled();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("binds the credential helper's signed scope to the pod's repo", async () => {
    const env: Record<string, string> = {};
    await applyGitAccess(env, {
      workspaceId: null,
      ownerUserId: null,
      repoUrl: "git@github.com:Acme/Widgets.git",
    });
    const scope = new URL(env.OPTIO_GIT_CREDENTIAL_URL).searchParams.get("scope")!;
    expect(parseGitCredentialScope(scope)).toEqual({
      workspaceId: null,
      ownerUserId: null,
      repo: "https://github.com/acme/widgets",
    });
    expect(env.OPTIO_CREDENTIAL_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("GitLab optional token resolution", () => {
  it("does not require a plain token before the helper can resolve host credentials", () => {
    expect(requiredGitTokenSecret("gitlab")).toBeNull();
  });
  it("starts a signed helper even when no static token is available", async () => {
    const env: Record<string, string> = {};
    await applyGitAccess(env, { workspaceId: "ws-1", repoUrl: "https://gitlab.com/org/repo" });
    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(env.OPTIO_GIT_CREDENTIAL_URL).toBeTruthy();
    expect(env.OPTIO_CREDENTIAL_SECRET).toBeTruthy();
  });
  it.each([true, false])(
    "uses a host-only token without requiring the plain secret (helper=%s)",
    async (helper) => {
      vi.stubEnv("GITLAB_HOSTS", "git.corp.example:8443,other.example:9443");
      vi.mocked(retrieveSecretWithFallback).mockImplementation(async (name) => {
        if (name === "GITLAB_TOKEN_GIT_CORP_EXAMPLE_8443") return "glpat-host-only";
        throw new Error("no plain token");
      });
      const env: Record<string, string> = {};
      await applyGitAccess(env, {
        workspaceId: "ws-1",
        repoUrl: "https://git.corp.example:8443/org/repo",
        helper,
      });
      expect(env.GITLAB_TOKEN).toBe("glpat-host-only");
      expect(env.GITLAB_HOST).toBe("git.corp.example:8443");
      expect(env.GITLAB_HOSTS).toBe("git.corp.example:8443");
    },
  );
  it("uses the API environment token when no stored token exists", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat-env-only");
    const env: Record<string, string> = {};
    await applyGitAccess(env, {
      workspaceId: null,
      repoUrl: "https://gitlab.com/org/repo",
      helper: false,
    });
    expect(env.GITLAB_TOKEN).toBe("glpat-env-only");
  });
});
