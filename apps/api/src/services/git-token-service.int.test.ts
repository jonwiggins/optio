/** Repository registration must never authorize a host to receive deployment credentials. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { repos } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertRepo, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { repoRoutes } from "../routes/repos.js";
import { getGitPlatformForRepo, isTrustedGitHost } from "./git-token-service.js";
import { getGitHubToken } from "./github-token-service.js";
import * as secretService from "./secret-service.js";
import { setOutboundDefaults } from "../utils/outbound-url.js";

vi.mock("./oauth/index.js", () => ({ isAuthDisabled: () => false }));
vi.mock("./github-token-service.js", () => ({
  getGitHubToken: vi.fn(async () => "deployment-token"),
}));
vi.mock("./optio-action-service.js", () => ({ logAction: vi.fn().mockResolvedValue(undefined) }));

const apps: Array<Awaited<ReturnType<typeof buildRouteTestApp>>> = [];
let restoreOutbound: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ["GITHUB_HOSTS", "OPTIO_GITHUB_HOSTS", "GITLAB_HOSTS", "OPTIO_GITLAB_HOSTS"])
    vi.stubEnv(name, "");
  vi.spyOn(secretService, "retrieveSecretWithFallback").mockResolvedValue(
    "deployment-gitlab-token",
  );
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(new Response("[]", { headers: { "content-type": "application/json" } })),
  );
  restoreOutbound = setOutboundDefaults({
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: (url, init) => fetch(url, init),
  });
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  restoreOutbound?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("deployment Git credential destinations", () => {
  it.each(["attacker.example", "gitlab.attacker.example"])(
    "registers %s without sending or resolving any token during autodetection",
    async (host) => {
      const workspace = await insertWorkspace();
      const app = await buildRouteTestApp(repoRoutes, {
        user: { id: randomUUID(), workspaceId: workspace.id, workspaceRole: "admin" },
      });
      apps.push(app);
      const repoUrl = `https://${host}/acme/app`;
      const response = await app.inject({
        method: "POST",
        url: "/api/repos",
        payload: { repoUrl, fullName: "acme/app" },
      });
      expect(response.statusCode).toBe(201);
      const [stored] = await db.select().from(repos).where(eq(repos.id, response.json().repo.id));
      expect(stored).toMatchObject({ repoUrl, workspaceId: workspace.id });
      expect(
        (await app.inject({ method: "POST", url: `/api/repos/${stored.id}/detect` })).statusCode,
      ).toBe(200);
      await expect(
        getGitPlatformForRepo(repoUrl, { server: true, workspaceId: workspace.id }),
      ).rejects.toThrow("deployment operator");
      expect(getGitHubToken).not.toHaveBeenCalled();
      expect(secretService.retrieveSecretWithFallback).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("requires operator allowlisting even after a custom host is registered", async () => {
    await insertRepo({ repoUrl: "https://ghe.corp.example/acme/app", fullName: "acme/app" });
    expect(await isTrustedGitHost({ host: "ghe.corp.example", platform: "github" })).toBe(false);
    vi.stubEnv("GITHUB_HOSTS", "ghe.corp.example");
    expect(await isTrustedGitHost({ host: "GHE.CORP.EXAMPLE", platform: "github" })).toBe(true);
    expect(await isTrustedGitHost({ host: "ghe.corp.example.evil", platform: "github" })).toBe(
      false,
    );
    const { platform, ri } = await getGitPlatformForRepo("https://ghe.corp.example/acme/app", {
      server: true,
    });
    await platform.listRepoContents(ri);
    expect(getGitHubToken).toHaveBeenCalledWith({ server: true, workspaceId: undefined });
    expect(fetch).toHaveBeenCalledWith(
      "https://ghe.corp.example/api/v3/repos/acme/app/contents/",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer deployment-token" }),
      }),
    );
  });

  it("does not reintroduce global Git tokens when repo pod setup secrets are merged", async () => {
    const { repoPodEnv } = await import("./repo-pool-service.js");
    vi.spyOn(secretService, "resolveSecretsForSetup").mockResolvedValue({
      GITHUB_TOKEN: "global-gh",
      GITLAB_TOKEN: "global-gl",
      NPM_TOKEN: "setup-secret",
    });
    vi.spyOn(secretService, "workspaceRestrictsPodSecrets").mockResolvedValue(false);
    const untrusted = await repoPodEnv(
      { OPTIO_GIT_CREDENTIAL_URL: "helper", OPTIO_CREDENTIAL_SECRET: "key" },
      "https://attacker.example/o/r",
      null,
    );
    expect(untrusted).toEqual({ NPM_TOKEN: "setup-secret" });
    vi.stubEnv("GITLAB_HOSTS", "git.corp.example");
    const trusted = await repoPodEnv({}, "https://git.corp.example/o/r", null);
    expect(trusted).toMatchObject({ GITLAB_TOKEN: "global-gl", NPM_TOKEN: "setup-secret" });
  });
});

describe("workspace-scoped recorded platforms", () => {
  it("does not let another workspace's URL row select the credential platform", async () => {
    const a = await insertWorkspace(),
      b = await insertWorkspace();
    const repoUrl = "https://git.platform.example/org/shared";
    vi.stubEnv("GITHUB_HOSTS", "git.platform.example");
    // This is about which platform a URL resolves to, not whose GitLab token:
    // let every workspace use the deployment's (neither is the founding one).
    vi.stubEnv("OPTIO_GITLAB_SHARE_DEPLOYMENT_CREDENTIALS", "true");
    await db
      .insert(repos)
      .values({ repoUrl, fullName: "org/shared", workspaceId: a.id, gitPlatform: "gitlab" });
    await db
      .insert(repos)
      .values({ repoUrl, fullName: "org/shared", workspaceId: b.id, gitPlatform: "github" });
    expect(
      (await getGitPlatformForRepo(repoUrl, { server: true, workspaceId: a.id })).ri.platform,
    ).toBe("gitlab");
    expect(
      (await getGitPlatformForRepo(repoUrl, { server: true, workspaceId: b.id })).ri.platform,
    ).toBe("github");
    expect((await getGitPlatformForRepo(repoUrl, { server: true })).ri.platform).toBe("github");
  });
  it("corrects a recorded platform when the same URL is re-added", async () => {
    const workspace = await insertWorkspace();
    const { createRepo } = await import("./repo-service.js");
    const input = {
      repoUrl: "https://git.platform.example/org/correct",
      fullName: "org/correct",
      workspaceId: workspace.id,
    };
    const first = await createRepo({ ...input, gitPlatform: "github" });
    const corrected = await createRepo({ ...input, gitPlatform: "gitlab" });
    expect(corrected.id).toBe(first.id);
    expect(corrected.gitPlatform).toBe("gitlab");
  });
});
