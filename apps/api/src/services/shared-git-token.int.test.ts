/**
 * "Shared git token only for allowed repos" against real Postgres, the real
 * auth plugin and API keys. Off (the default), the deployment's git token is
 * every repo's fallback, as before. On, a workspace admin can't add a repo
 * only that token could open, and no run, pod or API call of their workspace
 * gets it for such a repo; a repo a deployment admin allowed for the
 * workspace still works, and so do the workspace's and the person's own
 * tokens.
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { repoRoutes } from "../routes/repos.js";
import { deploymentSettingsRoutes } from "../routes/deployment-settings.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { createApiKey } from "./api-key-service.js";
import { setDeploymentSetting } from "./deployment-settings.js";
import { foundingWorkspaceId } from "./founding-workspace.js";
import { applyGitAccess, resolveGitTokenSecret } from "./git-access-env.js";
import { getGitPlatformForRepo, getGitToken } from "./git-token-service.js";
import { getGitHubToken } from "./github-token-service.js";
import { storeSecret } from "./secret-service.js";
import {
  SHARED_GIT_TOKEN_REPOS_KEY,
  SHARED_GIT_TOKEN_SWITCH,
  SharedGitTokenRefusedError,
  forgetSharedGitTokenPolicy,
} from "./shared-git-token-policy.js";

const uniq = () => randomBytes(4).toString("hex");
const HOST = "gitlab.example.com";
const PAYMENTS = `https://${HOST}/finance/payments-core`;
const PLATFORM_APP = `https://${HOST}/platform/app`;
const GH_REPO = "https://github.com/acme/payments-core";

const saved = {
  auth: process.env.OPTIO_AUTH_DISABLED,
  hosts: process.env.GITLAB_HOSTS,
  gitlabToken: process.env.GITLAB_TOKEN,
};

let app: FastifyInstance;
let platformWs: { id: string; slug: string };
let otherWs: { id: string; slug: string };
let ownTokenWs: { id: string; slug: string };
let otherAdmin: { id: string; authorization: string };
let deploymentAdmin: { id: string; authorization: string };

async function user(ws: string, role: "admin" | "member", deploymentAdminRole = false) {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${uniq()}`,
      email: `${uniq()}@shared-git-token.it`,
      emailVerified: true,
      displayName: "it",
      defaultWorkspaceId: ws,
      deploymentAdmin: deploymentAdminRole,
    })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws, userId: u.id, role });
  return { id: u.id, authorization: `Bearer ${(await createApiKey(u.id, "it")).token}` };
}

async function restrict(on: boolean | null) {
  await setDeploymentSetting(SHARED_GIT_TOKEN_SWITCH.key, on, null);
  forgetSharedGitTokenPolicy();
}

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  process.env.GITLAB_HOSTS = HOST;
  process.env.GITLAB_TOKEN = "env-deployment-gitlab";
  // No real git host: detection after adding a repo must fail fast.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
  const founding = (await foundingWorkspaceId()) ?? (await insertWorkspace()).id;
  platformWs = await insertWorkspace();
  otherWs = await insertWorkspace();
  ownTokenWs = await insertWorkspace();
  deploymentAdmin = await user(founding, "admin", true);
  otherAdmin = await user(otherWs.id, "admin");

  // The deployment's own git credentials.
  await storeSecret("GITLAB_TOKEN", "deployment-gitlab", "global");
  await storeSecret("GITHUB_TOKEN", "deployment-github", "global");
  // A workspace that brought its own token for a repo (Repo → Secrets).
  await storeSecret("GITHUB_TOKEN", "workspace-own-github", GH_REPO, ownTokenWs.id);
  await storeSecret("GITLAB_TOKEN", "workspace-own-gitlab", PAYMENTS, ownTokenWs.id);
  // A person who brought their own.
  await storeSecret("GITLAB_TOKEN", "personal-gitlab", "user", null, otherAdmin.id);

  await setDeploymentSetting(
    SHARED_GIT_TOKEN_REPOS_KEY,
    [{ workspaceId: platformWs.id, pattern: `${HOST}/platform/*` }],
    null,
  );

  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(repoRoutes);
  await app.register(deploymentSettingsRoutes);
  await app.ready();
});

afterAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = saved.auth;
  process.env.GITLAB_HOSTS = saved.hosts;
  process.env.GITLAB_TOKEN = saved.gitlabToken;
  vi.unstubAllGlobals();
  await app?.close();
});

beforeEach(() => forgetSharedGitTokenPolicy());

const addRepo = (who: { authorization: string }, repoUrl: string) =>
  app.inject({
    method: "POST",
    url: "/api/repos",
    headers: who,
    payload: { repoUrl, fullName: repoUrl.split("/").slice(-2).join("/") },
  });

describe("switch off (the default)", () => {
  beforeAll(() => restrict(null));

  it("the deployment's token is every repo's fallback, as before", async () => {
    const { token } = await getGitPlatformForRepo(PAYMENTS, {
      server: true,
      workspaceId: otherWs.id,
    });
    expect(token).toBe("deployment-gitlab");
    expect(await getGitHubToken({ server: true, workspaceId: otherWs.id, repoUrl: GH_REPO })).toBe(
      "deployment-github",
    );
    expect(await resolveGitTokenSecret("GITHUB_TOKEN", GH_REPO, otherWs.id, null)).toEqual({
      GITHUB_TOKEN: "deployment-github",
    });
  });

  it("any workspace admin adds any repo", async () => {
    const res = await addRepo(otherAdmin, `${PAYMENTS}-off-${uniq()}`);
    expect(res.statusCode).toBe(201);
  });
});

describe("switch on: shared git token only for allowed repos", () => {
  beforeAll(() => restrict(true));

  it("a workspace admin can't add a repo only the shared token could open", async () => {
    // The person's own token is for this host, so use an admin without one.
    const outsider = await user(otherWs.id, "admin");
    const res = await addRepo(outsider, PAYMENTS);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("isn't allowed for");
    expect(res.json().error).toContain("Settings → Access → Shared git token");
  });

  it("no API call, pod or run of that workspace gets the shared token for it", async () => {
    await expect(
      getGitPlatformForRepo(PAYMENTS, { server: true, workspaceId: otherWs.id }),
    ).rejects.toBeInstanceOf(SharedGitTokenRefusedError);
    // Nor the API's environment token.
    await expect(
      getGitToken("gitlab", { server: true, workspaceId: otherWs.id, host: HOST }),
    ).rejects.toBeInstanceOf(SharedGitTokenRefusedError);
    await expect(
      getGitHubToken({ server: true, workspaceId: otherWs.id, repoUrl: GH_REPO }),
    ).rejects.toBeInstanceOf(SharedGitTokenRefusedError);
    await expect(
      resolveGitTokenSecret("GITHUB_TOKEN", GH_REPO, otherWs.id, null),
    ).rejects.toBeInstanceOf(SharedGitTokenRefusedError);

    const env: Record<string, string> = {};
    await applyGitAccess(env, { workspaceId: otherWs.id, repoUrl: PAYMENTS, helper: false });
    expect(JSON.stringify(env)).not.toMatch(/deployment-git(lab|hub)|env-deployment/);
  });

  it("without a workspace or a repo, the shared token is never used", async () => {
    await expect(getGitPlatformForRepo(PLATFORM_APP, { server: true })).rejects.toBeInstanceOf(
      SharedGitTokenRefusedError,
    );
    await expect(getGitHubToken({ server: true, workspaceId: platformWs.id })).rejects.toThrow(
      SharedGitTokenRefusedError,
    );
  });

  it("an allowed repo still uses the shared token, and only in its workspace", async () => {
    const { token } = await getGitPlatformForRepo(PLATFORM_APP, {
      server: true,
      workspaceId: platformWs.id,
    });
    expect(token).toBe("deployment-gitlab");
    await expect(
      getGitPlatformForRepo(PLATFORM_APP, { server: true, workspaceId: otherWs.id }),
    ).rejects.toBeInstanceOf(SharedGitTokenRefusedError);
    // A path that only looks like it is below the allowed group.
    await expect(
      getGitPlatformForRepo(`https://${HOST}/platform/../finance/payments-core`, {
        server: true,
        workspaceId: platformWs.id,
      }),
    ).rejects.toBeInstanceOf(SharedGitTokenRefusedError);

    const env: Record<string, string> = {};
    await applyGitAccess(env, { workspaceId: platformWs.id, repoUrl: PLATFORM_APP });
    expect(env.GITLAB_TOKEN).toBe("deployment-gitlab");
  });

  it("the workspace's own token and a person's own token still work", async () => {
    // A run's git token: the workspace's own repo secret.
    expect(await resolveGitTokenSecret("GITHUB_TOKEN", GH_REPO, ownTokenWs.id, null)).toEqual({
      GITHUB_TOKEN: "workspace-own-github",
    });
    // A pod's GitLab sign-in: the same.
    const repoEnv: Record<string, string> = {};
    await applyGitAccess(repoEnv, { workspaceId: ownTokenWs.id, repoUrl: PAYMENTS, helper: false });
    expect(repoEnv.GITLAB_TOKEN).toBe("workspace-own-gitlab");
    // Without one, the same workspace is refused.
    await expect(
      resolveGitTokenSecret("GITHUB_TOKEN", `${GH_REPO}-other`, ownTokenWs.id, null),
    ).rejects.toBeInstanceOf(SharedGitTokenRefusedError);

    const personal = await getGitPlatformForRepo(PAYMENTS, {
      userId: otherAdmin.id,
      workspaceId: otherWs.id,
    });
    expect(personal.token).toBe("personal-gitlab");
    expect((await addRepo(otherAdmin, `${PAYMENTS}-mine`)).statusCode).toBe(201);

    const env: Record<string, string> = {};
    await applyGitAccess(env, {
      workspaceId: otherWs.id,
      ownerUserId: otherAdmin.id,
      repoUrl: PAYMENTS,
      helper: false,
    });
    expect(env.GITLAB_TOKEN).toBe("personal-gitlab");
  });

  it("the shared token's browse picker says why it lists nothing", async () => {
    const outsider = await user(otherWs.id, "admin");
    const res = await app.inject({
      method: "GET",
      url: "/api/repos/github/accessible",
      headers: outsider,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().repos).toEqual([]);
    expect(res.json().error).toContain("only used for repositories a deployment admin allowed");
  });
});

describe("Settings → Access → Shared git token", () => {
  const URL = "/api/deployment-settings/shared-git-token";

  it("a deployment admin sets the switch and the allowlist by workspace slug", async () => {
    const put = await app.inject({
      method: "PUT",
      url: URL,
      headers: deploymentAdmin,
      payload: {
        restricted: true,
        repos: [
          { workspace: otherWs.slug, pattern: `HTTPS://${HOST}/finance/payments-core.git` },
          { workspace: platformWs.slug, pattern: `${HOST}/platform/*` },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ value: true, source: "app" });
    expect(put.json().repos).toEqual([
      { workspace: otherWs.slug, pattern: `${HOST}/finance/payments-core` },
      { workspace: platformWs.slug, pattern: `${HOST}/platform/*` },
    ]);
    // Now allowed for that workspace.
    const { token } = await getGitPlatformForRepo(PAYMENTS, {
      server: true,
      workspaceId: otherWs.id,
    });
    expect(token).toBe("deployment-gitlab");
  });

  it("refuses an unknown workspace or a malformed pattern, and anyone but a deployment admin", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: URL,
      headers: deploymentAdmin,
      payload: { repos: [{ workspace: "no-such-ws", pattern: "*" }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('No workspace "no-such-ws"');
    const pattern = await app.inject({
      method: "PUT",
      url: URL,
      headers: deploymentAdmin,
      payload: { repos: [{ workspace: otherWs.slug, pattern: "host/a/../b" }] },
    });
    expect(pattern.statusCode).toBe(400);
    // Nothing was saved by either.
    const kept = await app.inject({ method: "GET", url: URL, headers: deploymentAdmin });
    expect(kept.json().repos).toHaveLength(2);

    for (const method of ["GET", "PUT"] as const) {
      const res = await app.inject({
        method,
        url: URL,
        headers: otherAdmin,
        ...(method === "PUT" ? { payload: { restricted: false } } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
  });
});
