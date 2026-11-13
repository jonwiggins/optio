/**
 * A workspace's own GitLab credentials against real Postgres: stored sealed
 * and bound to the workspace, read by that workspace alone, never shadowed
 * by the deployment's, and the deployment's kept to the founding workspace
 * unless the operator shares them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { secrets, workspaceGitlabServers, workspaces } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { retrieveSecret, setSecretDeploymentDefault, storeSecret } from "./secret-service.js";
import {
  gitLabTokenNameForHost,
  listWorkspaceGitLabServers,
  usesDeploymentGitLab,
  removeWorkspaceGitLabServer,
  saveWorkspaceGitLabServer,
  setDefaultWorkspaceGitLabServer,
  workspaceGitLabHosts,
  workspaceGitLabToken,
  type GitLabTokenChecker,
} from "./workspace-gitlab-service.js";
import { getGitToken } from "./git-token-service.js";

/** A GitLab that knows two tokens; nothing leaves the test. */
const check: GitLabTokenChecker = async (_host, token) =>
  token.startsWith("glpat-")
    ? { valid: true, username: `${token.slice(6)}-bot`, name: null }
    : { valid: false, error: "GitLab returned 401" };

let founding: string;
let teamA: string;
let teamB: string;

beforeAll(async () => {
  // The per-file database is fresh: the first workspace is the founding one.
  founding = (await insertWorkspace({ name: "founding", createdAt: new Date(2020, 0, 1) })).id;
  teamA = (await insertWorkspace({ name: "team a" })).id;
  teamB = (await insertWorkspace({ name: "team b" })).id;
});

beforeEach(() => {
  vi.stubEnv("GITLAB_HOSTS", "git.corp.test,git.other.test:8443");
  vi.stubEnv("GITLAB_TOKEN", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(workspaceGitlabServers);
  await db.delete(secrets);
});

describe("saving a workspace's GitLab server", () => {
  it("stores the token sealed and bound to the workspace, and never lists it", async () => {
    const server = await saveWorkspaceGitLabServer(
      teamA,
      { host: "https://Git.Corp.Test/", token: "glpat-team-a" },
      { check },
    );
    expect(server).toMatchObject({
      host: "git.corp.test",
      accountUsername: "team-a-bot",
      isDefault: true,
      hasToken: true,
    });
    expect(JSON.stringify(await listWorkspaceGitLabServers(teamA))).not.toContain("glpat");

    const [row] = await db
      .select()
      .from(secrets)
      .where(eq(secrets.name, gitLabTokenNameForHost("git.corp.test")));
    expect(row).toMatchObject({ scope: "workspace", workspaceId: teamA, userId: null });
    expect(row.encryptedValue.toString("utf8")).not.toContain("glpat-team-a");
    // Its AAD binds team A: read as another workspace's row, it doesn't open.
    await expect(
      retrieveSecret(gitLabTokenNameForHost("git.corp.test"), "workspace", teamB),
    ).rejects.toThrow();
  });

  it("refuses a host the operator hasn't listed, and a token that doesn't sign in", async () => {
    await expect(
      saveWorkspaceGitLabServer(
        teamA,
        { host: "gitlab.attacker.test", token: "glpat-x" },
        { check },
      ),
    ).rejects.toThrow(/GITLAB_HOSTS/);
    await expect(
      saveWorkspaceGitLabServer(teamA, { host: "git.other.test", token: "glpat-x" }, { check }),
    ).rejects.toThrow(/GITLAB_HOSTS/); // listed with a port only
    await expect(
      saveWorkspaceGitLabServer(teamA, { host: "git.corp.test", token: "bad" }, { check }),
    ).rejects.toThrow(/didn't sign in/);
    expect(await listWorkspaceGitLabServers(teamA)).toEqual([]);
    expect(await db.select().from(secrets)).toEqual([]);
  });

  it("replaces a token in place, moves the default, and removes a server with its token", async () => {
    const corp = await saveWorkspaceGitLabServer(
      teamA,
      { host: "git.corp.test", token: "glpat-one" },
      { check },
    );
    const other = await saveWorkspaceGitLabServer(
      teamA,
      { host: "git.other.test:8443", token: "glpat-two" },
      { check },
    );
    expect(other.isDefault).toBe(false);
    expect(await workspaceGitLabHosts(teamA)).toEqual(["git.corp.test", "git.other.test:8443"]);

    await saveWorkspaceGitLabServer(
      teamA,
      { host: "git.corp.test", token: "glpat-three" },
      { check },
    );
    expect(await workspaceGitLabToken(teamA, "git.corp.test")).toBe("glpat-three");
    expect(await listWorkspaceGitLabServers(teamA)).toHaveLength(2);

    await setDefaultWorkspaceGitLabServer(teamA, other.id);
    expect(await workspaceGitLabHosts(teamA)).toEqual(["git.other.test:8443", "git.corp.test"]);

    await removeWorkspaceGitLabServer(teamA, other.id);
    expect(await workspaceGitLabHosts(teamA)).toEqual(["git.corp.test"]);
    expect((await listWorkspaceGitLabServers(teamA))[0].isDefault).toBe(true);
    expect(await workspaceGitLabToken(teamA, "git.other.test:8443")).toBeNull();
    const left = await db
      .select({ name: secrets.name })
      .from(secrets)
      .where(and(eq(secrets.scope, "workspace"), eq(secrets.workspaceId, teamA)));
    expect(left.map((r) => r.name)).toEqual([gitLabTokenNameForHost(corp.host)]);
  });

  it("can't change another workspace's server", async () => {
    const corp = await saveWorkspaceGitLabServer(
      teamA,
      { host: "git.corp.test", token: "glpat-a" },
      { check },
    );
    await expect(removeWorkspaceGitLabServer(teamB, corp.id)).rejects.toThrow(/not found/);
    await expect(setDefaultWorkspaceGitLabServer(teamB, corp.id)).rejects.toThrow(/not found/);
    expect(await workspaceGitLabToken(teamA, "git.corp.test")).toBe("glpat-a");
  });

  it("goes with its workspace", async () => {
    const gone = (await insertWorkspace({ name: "short-lived" })).id;
    await saveWorkspaceGitLabServer(gone, { host: "gitlab.com", token: "glpat-x" }, { check });
    await db.delete(workspaces).where(eq(workspaces.id, gone));
    expect(await listWorkspaceGitLabServers(gone)).toEqual([]);
  });
});

describe("which GitLab token work gets", () => {
  it("each workspace its own, the other's never", async () => {
    await saveWorkspaceGitLabServer(teamA, { host: "git.corp.test", token: "glpat-a" }, { check });
    await saveWorkspaceGitLabServer(teamB, { host: "git.corp.test", token: "glpat-b" }, { check });
    const token = (workspaceId: string | null) =>
      getGitToken("gitlab", { server: true, workspaceId, host: "git.corp.test" });
    expect(await token(teamA)).toBe("glpat-a");
    expect(await token(teamB)).toBe("glpat-b");
    // Neither the founding workspace nor a caller with no workspace reads them.
    await expect(token(founding)).rejects.toThrow();
    await expect(token(null)).rejects.toThrow();
  });

  it("the deployment's serves the founding workspace, not the others", async () => {
    await storeSecret("GITLAB_TOKEN", "glpat-deployment", "global");
    expect(await usesDeploymentGitLab(founding)).toBe(true);
    expect(await usesDeploymentGitLab(teamA)).toBe(false);
    expect(await usesDeploymentGitLab(null)).toBe(true);
    expect(await getGitToken("gitlab", { server: true, workspaceId: founding })).toBe(
      "glpat-deployment",
    );
    await expect(
      getGitToken("gitlab", { server: true, workspaceId: teamA, host: "gitlab.com" }),
    ).rejects.toThrow(/Workspace Settings → GitLab/);
    // The API's environment can't be shared: the founding workspace's alone.
    await db.delete(secrets);
    vi.stubEnv("GITLAB_TOKEN", "glpat-env");
    expect(await getGitToken("gitlab", { server: true, workspaceId: founding })).toBe("glpat-env");
    await expect(getGitToken("gitlab", { server: true, workspaceId: teamA })).rejects.toThrow();
  });

  it("a workspace's own wins over the deployment's, even in the founding workspace", async () => {
    await storeSecret(gitLabTokenNameForHost("git.corp.test"), "glpat-deployment", "global");
    await saveWorkspaceGitLabServer(
      founding,
      { host: "git.corp.test", token: "glpat-own" },
      { check },
    );
    expect(
      await getGitToken("gitlab", { server: true, workspaceId: founding, host: "git.corp.test" }),
    ).toBe("glpat-own");
  });

  it("a deployment admin can share the deployment's with every workspace", async () => {
    await storeSecret("GITLAB_TOKEN", "glpat-deployment", "global");
    expect(await setSecretDeploymentDefault("GITLAB_TOKEN", "global", true)).toBe(true);
    expect(await usesDeploymentGitLab(teamA)).toBe(true);
    expect(await getGitToken("gitlab", { server: true, workspaceId: teamA })).toBe(
      "glpat-deployment",
    );
    await saveWorkspaceGitLabServer(teamA, { host: "gitlab.com", token: "glpat-own" }, { check });
    expect(
      await getGitToken("gitlab", { server: true, workspaceId: teamA, host: "gitlab.com" }),
    ).toBe("glpat-own");
    await setSecretDeploymentDefault("GITLAB_TOKEN", "global", false);
    expect(await usesDeploymentGitLab(teamB)).toBe(false);
  });

  it("knows the deployment's GITLAB_HOST only where it may be used, never a workspace's own", async () => {
    const { deploymentGitLabHost } = await import("./workspace-gitlab-service.js");
    await storeSecret("GITLAB_HOST", "git.wizard.test", "global");
    await storeSecret("GITLAB_HOST", "git.evil.test", "workspace", teamA);
    expect(await deploymentGitLabHost(founding)).toBe("git.wizard.test");
    expect(await deploymentGitLabHost(teamA)).toBeNull();
    await setSecretDeploymentDefault("GITLAB_HOST", "global", true);
    expect(await deploymentGitLabHost(teamA)).toBe("git.wizard.test");
  });
});
