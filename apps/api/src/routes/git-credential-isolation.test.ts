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

beforeEach(() => {
  vi.stubEnv("OPTIO_ENCRYPTION_KEY", "unit-test-scope-key");
  vi.stubEnv("OPTIO_ALLOW_LEGACY_GIT_CREDENTIALS", "");
  membership.mockReset().mockResolvedValue("member");
  resetCredentialSecret();
  token.mockReset().mockResolvedValue("private-token");
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
