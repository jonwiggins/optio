import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// applyGitAccess for a repo on a registered GitLab instance
// (docs/gitlab-instances.md): the token is resolved once, best effort, and
// the instance's API base and CA reach the pod either way.

const getGitToken = vi.hoisted(() => vi.fn());
vi.mock("./gitlab-instance-service.js", () => ({ refreshGitLabInstances: async () => {} }));
vi.mock("./github-app-service.js", () => ({
  isGitHubAppConfigured: () => false,
  getInstallationToken: vi.fn(),
}));
vi.mock("./secret-service.js", () => ({
  retrieveSecretWithFallback: vi.fn().mockRejectedValue(new Error("none")),
}));
vi.mock("./git-token-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-token-service.js")>()),
  getGitToken,
}));
vi.mock("../db/client.js", () => ({ db: {} }));

import { applyGitAccess } from "./git-access-env.js";
import { configureGitLabInstances } from "./gitlab-instance-runtime.js";

const base = "https://gitlab.example.test:8443/gitlab";
const repoUrl = `${base}/group/project`;
const caPem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

beforeEach(() => {
  vi.stubEnv("OPTIO_ENCRYPTION_KEY", "unit-test-git-access-key");
  for (const name of ["GITHUB_HOSTS", "OPTIO_GITHUB_HOSTS", "GITLAB_HOSTS", "OPTIO_GITLAB_HOSTS"])
    vi.stubEnv(name, "");
  getGitToken.mockReset();
  configureGitLabInstances([{ baseUrl: base, caPem, token: null }]);
});
afterEach(() => {
  configureGitLabInstances([]);
  vi.unstubAllEnvs();
});

describe("applyGitAccess on a registered GitLab instance", () => {
  it.each([true, false])(
    "starts without a token anywhere instead of throwing (helper=%s)",
    async (helper) => {
      getGitToken.mockRejectedValue(new Error("No GitLab token configured"));
      const env: Record<string, string> = {};
      await expect(applyGitAccess(env, { workspaceId: "ws-1", repoUrl, helper })).resolves.toBe(
        undefined,
      );
      expect(env.GITLAB_TOKEN).toBeUndefined();
      expect(env).toMatchObject({
        GITLAB_HOST: "gitlab.example.test:8443",
        OPTIO_GITLAB_BASE_URL: base,
        OPTIO_GITLAB_CA_PEM: caPem,
      });
      expect(env.OPTIO_GITLAB_CA_FILE).toMatch(
        /^\/home\/agent\/\.config\/optio\/gitlab\/\w+\.pem$/,
      );
      expect(getGitToken).toHaveBeenCalledTimes(1);
    },
  );

  it("resolves the instance's token once, and keeps a token the caller picked", async () => {
    getGitToken.mockResolvedValue("glpat-instance");
    const env: Record<string, string> = {};
    await applyGitAccess(env, { workspaceId: "ws-1", repoUrl, helper: false });
    expect(env.GITLAB_TOKEN).toBe("glpat-instance");
    expect(getGitToken).toHaveBeenCalledTimes(1);
    expect(getGitToken).toHaveBeenCalledWith("gitlab", {
      workspaceId: "ws-1",
      userId: undefined,
      host: "gitlab.example.test:8443",
    });

    getGitToken.mockClear();
    const picked: Record<string, string> = { GITLAB_TOKEN: "work-selected" };
    await applyGitAccess(picked, { workspaceId: "ws-1", repoUrl, helper: false });
    expect(picked.GITLAB_TOKEN).toBe("work-selected");
    expect(picked.OPTIO_GITLAB_BASE_URL).toBe(base);
    expect(getGitToken).not.toHaveBeenCalled();
  });
});
