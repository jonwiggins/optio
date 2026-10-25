import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { computeSignature } from "../services/hmac-auth-service.js";
import { gitCredentialKey, gitCredentialScope } from "../services/git-credential-scope.js";
import {
  getCredentialSecret,
  resetCredentialSecret,
} from "../services/credential-secret-service.js";
import githubAppRoutes from "./github-app.js";

const membership = vi.hoisted(() => vi.fn());
vi.mock("../services/workspace-service.js", () => ({ getUserRole: membership }));
const token = vi.hoisted(() => vi.fn());
vi.mock("../services/github-token-service.js", () => ({ getGitHubToken: token }));
const gitlabToken = vi.hoisted(() => vi.fn());
vi.mock("../services/git-token-service.js", () => ({ getGitToken: gitlabToken }));
const wizardHost = vi.hoisted(() => vi.fn());
vi.mock("../services/secret-service.js", () => ({ retrieveSecretWithFallback: wizardHost }));

beforeEach(() => {
  vi.stubEnv("OPTIO_ENCRYPTION_KEY", "unit-test-scope-key");
  vi.stubEnv("OPTIO_ALLOW_LEGACY_GIT_CREDENTIALS", "");
  membership.mockReset().mockResolvedValue("member");
  resetCredentialSecret();
  token.mockReset().mockResolvedValue("private-token");
  gitlabToken.mockReset().mockResolvedValue("glpat-owner");
  wizardHost.mockReset().mockRejectedValue(new Error("Secret not found"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetCredentialSecret();
});

async function call(scope: string | null, secret: string, suffix = "") {
  const app = await buildRouteTestApp(githubAppRoutes, { user: null });
  const path = `/api/internal/git-credentials${scope ? `?scope=${scope}` : ""}${suffix}`;
  const now = Math.floor(Date.now() / 1000);
  const result = await app.inject({
    method: "GET",
    url: path,
    headers: { "x-optio-signature": `t=${now},sig=${computeSignature(secret, now, path)}` },
  });
  await app.close();
  return result;
}

describe("credential helper scope", () => {
  it("refreshes only the owner's credentials, ignoring any arbitrary taskId", async () => {
    const owner = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
    const scope = gitCredentialScope(owner);
    expect((await call(scope, gitCredentialKey(scope), `&taskId=${randomUUID()}`)).statusCode).toBe(
      200,
    );
    expect(token).toHaveBeenCalledWith({
      workspaceId: owner.workspaceId,
      userId: owner.ownerUserId,
    });
  });
  it("rejects changing owner, workspace, or promoting an org key to a user key", async () => {
    const owner = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
    const key = gitCredentialKey(gitCredentialScope(owner));
    for (const other of [
      { ...owner, ownerUserId: randomUUID() },
      { ...owner, workspaceId: randomUUID() },
      { ...owner, ownerUserId: null },
    ]) {
      expect((await call(gitCredentialScope(other), key)).statusCode).toBe(401);
    }
    expect(token).not.toHaveBeenCalled();
  });
  it("hands a team's work the organization's token, never its creator's own", async () => {
    const owner = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
    const team = { ...owner, ownerTeamId: randomUUID() };
    const scope = gitCredentialScope(team);
    expect((await call(scope, gitCredentialKey(scope))).statusCode).toBe(200);
    expect(token).toHaveBeenCalledWith({ server: true, workspaceId: owner.workspaceId });
    // The team's key is no key to its creator's own credentials.
    token.mockClear();
    expect((await call(gitCredentialScope(owner), gitCredentialKey(scope))).statusCode).toBe(401);
    expect(token).not.toHaveBeenCalled();
  });
  it("rejects a removed member and a key forged from the old pod secret", async () => {
    const scope = gitCredentialScope({ workspaceId: randomUUID(), ownerUserId: randomUUID() });
    membership.mockResolvedValue(null);
    expect((await call(scope, gitCredentialKey(scope))).statusCode).toBe(401);
    const forged = createHmac("sha256", getCredentialSecret())
      .update(`git-credentials:v1:${scope}`)
      .digest("hex");
    expect((await call(scope, forged)).statusCode).toBe(401);
    expect(token).not.toHaveBeenCalled();
  });
  it("rejects old deployment keys by default and cannot use a derived key on the unscoped endpoint", async () => {
    expect((await call(null, getCredentialSecret())).statusCode).toBe(401);
    expect(
      (
        await call(
          null,
          gitCredentialKey(gitCredentialScope({ workspaceId: null, ownerUserId: null })),
        )
      ).statusCode,
    ).toBe(401);
    expect(token).not.toHaveBeenCalled();
  });
});

describe("credential helper for a GitLab host", () => {
  it("hands the run owner's GitLab token for a host the deployment named, signed like GitHub's", async () => {
    vi.stubEnv("GITLAB_HOSTS", "git.example.test");
    const owner = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
    const scope = gitCredentialScope(owner);
    const res = await call(scope, gitCredentialKey(scope), "&host=git.example.test%3A8443");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: "glpat-owner", username: "oauth2" });
    expect(gitlabToken).toHaveBeenCalledWith("gitlab", {
      userId: owner.ownerUserId,
      server: false,
      workspaceId: owner.workspaceId,
      ownerTeamId: null,
      host: "git.example.test:8443",
    });
    expect(token).not.toHaveBeenCalled();
  });

  it("knows gitlab.com and the setup wizard's GITLAB_HOST; a team's work asks for the team's", async () => {
    wizardHost.mockResolvedValue("https://gitlab.wizard.test/");
    const team = {
      workspaceId: randomUUID(),
      ownerUserId: randomUUID(),
      ownerTeamId: randomUUID(),
    };
    const scope = gitCredentialScope(team);
    for (const host of ["gitlab.com", "gitlab.wizard.test"]) {
      expect((await call(scope, gitCredentialKey(scope), `&host=${host}`)).statusCode).toBe(200);
    }
    expect(gitlabToken).toHaveBeenLastCalledWith(
      "gitlab",
      expect.objectContaining({ ownerTeamId: team.ownerTeamId, server: false }),
    );
  });

  it("answers nothing for a host nobody named, and still checks the owner's access", async () => {
    const owner = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
    const scope = gitCredentialScope(owner);
    expect((await call(scope, gitCredentialKey(scope), "&host=evil.example")).statusCode).toBe(404);
    membership.mockResolvedValue(null);
    expect((await call(scope, gitCredentialKey(scope), "&host=gitlab.com")).statusCode).toBe(401);
    expect(gitlabToken).not.toHaveBeenCalled();
  });

  it("the legacy unscoped key answers github.com alone: any other host gets nothing", async () => {
    vi.stubEnv("OPTIO_ALLOW_LEGACY_GIT_CREDENTIALS", "1");
    vi.stubEnv("GITLAB_HOSTS", "git.example.test");
    for (const host of ["evil.example", "gitlab.com", "git.example.test"]) {
      expect((await call(null, getCredentialSecret(), `?host=${host}`)).statusCode).toBe(404);
    }
    expect(token).not.toHaveBeenCalled();
    expect(gitlabToken).not.toHaveBeenCalled();
    const github = await call(null, getCredentialSecret(), "?host=github.com");
    expect(github.statusCode).toBe(200);
    expect(github.json()).toEqual({ token: "private-token" });
  });

  it("github.com stays GitHub's", async () => {
    const owner = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
    const scope = gitCredentialScope(owner);
    const res = await call(scope, gitCredentialKey(scope), "&host=github.com");
    expect(res.json()).toEqual({ token: "private-token" });
    expect(gitlabToken).not.toHaveBeenCalled();
  });
});
