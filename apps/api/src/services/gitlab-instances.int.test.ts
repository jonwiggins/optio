import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { parseRepoUrl } from "@optio/shared";
import { GitLabTicketProvider } from "@optio/ticket-providers";
import { db } from "../db/client.js";
import { gitlabInstances, secrets, users, teams, workspaces } from "../db/schema.js";
import { fakeGitLabHttps } from "../test-utils/fake-gitlab-https.js";
import {
  listGitLabInstances,
  saveGitLabInstance,
  deleteGitLabInstance,
  testGitLabInstance,
  refreshGitLabInstances,
} from "./gitlab-instance-service.js";
import {
  configureGitLabInstances,
  gitLabFetch,
  runtimeGitLabInstance,
} from "./gitlab-instance-runtime.js";
import { getGitPlatformForRepo, getGitToken, gitLabTokenNameForHost } from "./git-token-service.js";
import { storeSecret } from "./secret-service.js";
import { applyGitAccess } from "./git-access-env.js";
import { CONFIGURE_GITLAB_CA } from "../utils/pod-env.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { computeSignature } from "./hmac-auth-service.js";
import { gitCredentialKey, gitCredentialScope } from "./git-credential-scope.js";
import githubAppRoutes from "../routes/github-app.js";
import { repoRoutes } from "../routes/repos.js";

let gl: Awaited<ReturnType<typeof fakeGitLabHttps>>;
const userId = randomUUID(),
  workspaceId = randomUUID(),
  teamId = randomUUID();
beforeAll(async () => {
  gl = await fakeGitLabHttps();
  await db.insert(users).values({
    id: userId,
    provider: "gitlab",
    externalId: "glinst-test",
    email: "tester@example.com",
    displayName: "Tester",
  });
  await db.insert(workspaces).values({ id: workspaceId, name: "Test", slug: "glinst-test" });
  await db.insert(teams).values({ id: teamId, workspaceId, name: "Test", slug: "test" });
});
beforeEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(gitlabInstances);
  await db.delete(secrets);
  await refreshGitLabInstances(true);
  gl.requests.length = 0;
});
afterAll(async () => {
  configureGitLabInstances([]);
  vi.unstubAllEnvs();
  await gl.close();
});
const input = () => ({
  baseUrl: gl.baseUrl,
  displayName: "Test GitLab",
  caPem: gl.caPem,
  token: "instance-token",
});
const host = () => new URL(gl.baseUrl).host;

describe("glinst encrypted configuration", () => {
  it("applies the additive migration and stores no plaintext token", async () => {
    const row = await saveGitLabInstance(input());
    expect(row).toMatchObject({ hasToken: true, source: "app" });
    expect(JSON.stringify(row)).not.toContain("instance-token");
    const [stored] = await db.select().from(gitlabInstances);
    expect(stored.encryptedToken?.toString()).not.toContain("instance-token");
    expect((await listGitLabInstances())[0].hasToken).toBe(true);
    expect(await getGitToken("gitlab", { server: true, host: host() })).toBe("instance-token");
  });

  it("preserves, rotates and clears the saved token", async () => {
    const row = await saveGitLabInstance(input());
    const { token: _, ...rest } = input();
    await saveGitLabInstance({ ...rest, displayName: "Renamed" }, row.id);
    expect(runtimeGitLabInstance(host())?.token).toBe("instance-token");
    await saveGitLabInstance({ ...rest, token: "new-token" }, row.id);
    expect(runtimeGitLabInstance(host())?.token).toBe("new-token");
    await saveGitLabInstance({ ...rest, token: null }, row.id);
    expect(runtimeGitLabInstance(host())?.token).toBeNull();
  });

  it("rejects a duplicate host/port and invalid CA and refuses to carry a saved token to a new URL", async () => {
    const row = await saveGitLabInstance(input());
    await expect(
      saveGitLabInstance({ ...input(), baseUrl: `${gl.baseUrl}/other` }),
    ).rejects.toThrow();
    await expect(saveGitLabInstance({ ...input(), caPem: "not a certificate" })).rejects.toThrow();
    const { token: _, ...rest } = input();
    await expect(
      saveGitLabInstance({ ...rest, baseUrl: "https://other.example.com" }, row.id),
    ).rejects.toThrow("token");
  });

  it("keeps env entries read-only and removal restores an empty runtime registry", async () => {
    vi.stubEnv("GITLAB_HOSTS", "git.example.com:8443,gitlab.com");
    vi.stubEnv("GITLAB_TOKEN_GIT_EXAMPLE_COM_8443", "env-token");
    const row = await saveGitLabInstance(input());
    const list = await listGitLabInstances();
    expect(list).toContainEqual(
      expect.objectContaining({
        baseUrl: "https://git.example.com:8443",
        source: "environment",
        hasToken: true,
      }),
    );
    expect(await deleteGitLabInstance(row.id)).toBe(true);
    expect(runtimeGitLabInstance(host())).toBeNull();
  });

  it("uses instance tokens only for their own host, after team and person tokens", async () => {
    await saveGitLabInstance(input());
    await storeSecret("GITLAB_TOKEN", "global-token", "global");
    expect(await getGitToken("gitlab", { server: true, host: host() })).toBe("instance-token");
    expect(await getGitToken("gitlab", { server: true, host: "other.example.com" })).toBe(
      "global-token",
    );
    await storeSecret(gitLabTokenNameForHost(host()), "personal-token", "user", null, userId);
    expect(await getGitToken("gitlab", { userId, workspaceId, host: host() })).toBe(
      "personal-token",
    );
    await storeSecret("GITLAB_TOKEN", "team-token", "team", workspaceId, null, teamId);
    expect(
      await getGitToken("gitlab", { userId, ownerTeamId: teamId, workspaceId, host: host() }),
    ).toBe("team-token");
  });
});

describe("glinst HTTPS and private CA", () => {
  it("browses a chosen instance and rejects unknown browser destinations", async () => {
    await saveGitLabInstance(input());
    const app = await buildRouteTestApp(repoRoutes, {
      user: { id: userId, workspaceId, workspaceRole: "admin" },
    });
    try {
      const result = await app.inject(
        `/api/repos/browse?platform=gitlab&instance=${encodeURIComponent(gl.baseUrl)}`,
      );
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ platform: "gitlab", host: host() });
      expect(result.json().repos).toHaveLength(1);
      const before = gl.requests.length;
      const unknown = await app.inject(
        "/api/repos/browse?platform=gitlab&instance=https%3A%2F%2Fother.example.com",
      );
      expect(unknown.json()).toMatchObject({ repos: [], error: "Unknown GitLab instance" });
      expect(gl.requests).toHaveLength(before);
    } finally {
      await app.close();
    }
  });

  it("serves instance credentials to a correctly signed pod helper only", async () => {
    await saveGitLabInstance(input());
    const app = await buildRouteTestApp(githubAppRoutes, { user: null });
    const scope = gitCredentialScope({ workspaceId: null, ownerUserId: null, ownerTeamId: null });
    const path = `/api/internal/git-credentials?scope=${scope}&host=${encodeURIComponent(host())}`;
    const now = Math.floor(Date.now() / 1000);
    try {
      expect((await app.inject(path)).statusCode).toBe(401);
      const result = await app.inject({
        url: path,
        headers: {
          "x-optio-signature": `t=${now},sig=${computeSignature(gitCredentialKey(scope), now, path)}`,
        },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ token: "instance-token", username: "oauth2" });
      expect(result.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("tests unsaved version and identity over HTTPS without changing configuration", async () => {
    expect(await testGitLabInstance(input())).toEqual({
      ok: true,
      version: "18.0.0",
      username: "test-bot",
    });
    expect(gl.requests.map((r) => r.url)).toEqual([
      "/gitlab/api/v4/version",
      "/gitlab/api/v4/user",
    ]);
    expect(gl.requests.every((r) => r.authorization === "Bearer instance-token")).toBe(true);
    expect(await listGitLabInstances()).toEqual([]);
  });

  it("rejects an untrusted CA and a wrong token", async () => {
    await expect(testGitLabInstance({ ...input(), caPem: null })).rejects.toThrow();
    await expect(testGitLabInstance({ ...input(), token: "wrong-token" })).rejects.toThrow(
      "HTTP 401",
    );
  });

  it("tests a saved token only for the same URL", async () => {
    const row = await saveGitLabInstance(input());
    const { token: _, ...rest } = input();
    expect((await testGitLabInstance(rest, row.id)).ok).toBe(true);
    await expect(
      testGitLabInstance({ ...rest, baseUrl: "https://other.example.com" }, row.id),
    ).rejects.toThrow("Enter a token");
  });

  it("uses the prefix, CA and token for repository browsing, metadata and webhooks", async () => {
    await saveGitLabInstance(input());
    const { platform, ri } = await getGitPlatformForRepo(`${gl.baseUrl}/group/project.git`, {
      server: true,
    });
    expect(ri).toMatchObject({
      platform: "gitlab",
      owner: "group",
      apiBaseUrl: `${gl.baseUrl}/api/v4`,
    });
    expect((await platform.getRepoMetadata(ri)).defaultBranch).toBe("main");
    expect(
      await platform.browseRepositories!("", { host: host(), apiBaseUrl: ri.apiBaseUrl }),
    ).toHaveLength(1);
    expect(
      await platform.ensureWebhook!(ri, {
        url: "https://optio.example.com/api/webhooks/gitlab",
        token: "test-hook-secret",
        events: ["push"],
      }),
    ).toMatchObject({ hookId: "7" });
    expect(gl.requests.every((r) => r.authorization === "Bearer instance-token")).toBe(true);
  });

  it("does not follow authenticated redirects or trust sibling paths or another instance", async () => {
    await saveGitLabInstance(input());
    await expect(
      gitLabFetch(`${gl.baseUrl}/api/v4/redirect`, {
        headers: { Authorization: "Bearer instance-token" },
      }),
    ).rejects.toThrow();
    expect(gl.requests.some((r) => r.url === "/elsewhere")).toBe(false);
    await expect(gitLabFetch(`${gl.baseUrl}-other/api/v4/user`)).rejects.toThrow();
    const other = await fakeGitLabHttps();
    try {
      await expect(gitLabFetch(`${other.baseUrl}/api/v4/user`)).rejects.toThrow();
    } finally {
      await other.close();
    }
  });

  it("shares instance CA trust with GitLab ticket providers", async () => {
    vi.stubEnv("OPTIO_ALLOW_PRIVATE_URLS", "1");
    await saveGitLabInstance(input());
    const provider = new GitLabTicketProvider();
    expect(
      await provider.fetchActionableTickets({
        token: "instance-token",
        host: gl.baseUrl,
        projectPath: "group/project",
      }),
    ).toEqual([]);
    expect(gl.requests.at(-1)?.url).toContain("/gitlab/api/v4/projects/group%2Fproject/issues");
  });

  it("passes the instance token to pods and configures CA trust for that URL only", async () => {
    await saveGitLabInstance(input());
    const env: Record<string, string> = { OPTIO_REPO_URL: `${gl.baseUrl}/group/project.git` };
    await applyGitAccess(env, { workspaceId, ownerUserId: userId });
    expect(env.GITLAB_TOKEN).toBe("instance-token");
    expect(env.OPTIO_GITLAB_CA_PEM).toBe(gl.caPem);
    expect(env.GITLAB_HOST).toBe(host());
    const supplied = { OPTIO_REPO_URL: env.OPTIO_REPO_URL, GITLAB_TOKEN: "work-selected-token" };
    await applyGitAccess(supplied, { workspaceId, ownerUserId: userId });
    expect(supplied.GITLAB_TOKEN).toBe("work-selected-token");
    const dir = mkdtempSync(join(tmpdir(), "optio-glinst-"));
    try {
      env.OPTIO_GITLAB_CA_FILE = join(dir, "ca.pem");
      const glab = join(dir, "glab");
      writeFileSync(glab, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GLINST_GLAB_CALLS"\n');
      chmodSync(glab, 0o700);
      execFileSync("bash", ["-c", CONFIGURE_GITLAB_CA.join("\n")], {
        env: {
          ...process.env,
          ...env,
          GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
          GLINST_GLAB_CALLS: join(dir, "glab-calls"),
          PATH: `${dir}:${process.env.PATH}`,
        },
      });
      expect(readFileSync(env.OPTIO_GITLAB_CA_FILE, "utf8").trim()).toBe(gl.caPem.trim());
      const config = readFileSync(join(dir, "gitconfig"), "utf8");
      expect(config).toContain(`[http "${gl.baseUrl}/"]`);
      expect(config).not.toContain("sslVerify");
      const cli = readFileSync(join(dir, "glab-calls"), "utf8");
      expect(cli).toContain(
        `config set api_host ${gl.baseUrl.replace(/^https:\/\//, "")} --host ${host()}`,
      );
      expect(cli).toContain(`config set ca_cert ${env.OPTIO_GITLAB_CA_FILE} --host ${host()}`);
      expect(cli).not.toContain("skip_tls_verify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes changes on another replica without restarting", async () => {
    const row = await saveGitLabInstance(input());
    await db
      .update(gitlabInstances)
      .set({ displayName: "Changed", caPem: null })
      .where(eq(gitlabInstances.id, row.id));
    await refreshGitLabInstances(true);
    expect(runtimeGitLabInstance(host())?.caPem).toBeNull();
    expect(parseRepoUrl(`${gl.baseUrl}/group/project`)?.apiBaseUrl).toBe(`${gl.baseUrl}/api/v4`);
  });
});
