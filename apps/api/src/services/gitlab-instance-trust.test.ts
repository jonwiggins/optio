import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ select: vi.fn(), secret: vi.fn() }));
vi.mock("../db/client.js", () => ({ db: { select: calls.select } }));
vi.mock("./gitlab-instance-service.js", () => ({ refreshGitLabInstances: async () => {} }));
vi.mock("./secret-service.js", () => ({
  retrieveSecret: calls.secret,
  retrieveSecretWithFallback: calls.secret,
}));
import { getGitPlatformForRepo, isTrustedGitHost } from "./git-token-service.js";
import { configureGitLabInstances } from "./gitlab-instance-runtime.js";
const ri = { host: "git.example.test:8443", platform: "gitlab" as const };
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ["GITLAB_HOSTS", "OPTIO_GITLAB_HOSTS", "GITHUB_HOSTS", "OPTIO_GITHUB_HOSTS"])
    vi.stubEnv(key, "");
  configureGitLabInstances([]);
  calls.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => [{ gitPlatform: "gitlab" }] }) }),
  });
});
afterEach(() => {
  configureGitLabInstances([]);
  vi.unstubAllEnvs();
});
describe("admin-managed GitLab trust", () => {
  it("does not let a repository record authorize deployment credentials", async () => {
    await expect(getGitPlatformForRepo(`https://${ri.host}/g/r`, { server: true })).rejects.toThrow(
      /Refusing to send git credentials/,
    );
    expect(calls.select).toHaveBeenCalled();
    expect(calls.secret).not.toHaveBeenCalled();
  });
  it("trusts an explicitly configured instance, and removal revokes it", async () => {
    expect(await isTrustedGitHost(ri)).toBe(false);
    configureGitLabInstances([{ baseUrl: `https://${ri.host}/gitlab`, caPem: null, token: null }]);
    expect(await isTrustedGitHost(ri)).toBe(true);
    expect(await isTrustedGitHost({ ...ri, host: "git.example.test" })).toBe(false);
    expect(await isTrustedGitHost({ ...ri, platform: "github" })).toBe(false);
    configureGitLabInstances([]);
    expect(await isTrustedGitHost(ri)).toBe(false);
  });
  it("preserves operator environment allowlisting independently of the registry", async () => {
    vi.stubEnv("GITLAB_HOSTS", ri.host);
    expect(await isTrustedGitHost(ri)).toBe(true);
    configureGitLabInstances([]);
    expect(await isTrustedGitHost(ri)).toBe(true);
  });
});
