/**
 * What belongs to the whole deployment (services/deployment-admin-gates.ts):
 * by default (`workspaces.creation: everyone`) anyone creates a workspace and
 * a workspace admin changes global secrets; under `admins` only deployment
 * admins do either. Opening a workspace to directory groups is always a
 * deployment admin's.
 */
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { optioActions, secrets, users, workspaceMembers, workspaces } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { retrieveSecret, storeSecret, deleteSecret } from "./secret-service.js";
import {
  mergeConfirmationRequired,
  onboardingEnabled,
  setDeploymentSetting,
  teamsEnabled,
} from "./deployment-settings.js";
import { secretRoutes } from "../routes/secrets.js";
import { workspaceRoutes } from "../routes/workspaces.js";
import { deploymentSettingsRoutes } from "../routes/deployment-settings.js";
import { agentCredentialRoutes } from "../routes/agent-credentials.js";
import { githubTokenRoutes } from "../routes/github-token.js";

async function insertUser(name: string, deploymentAdmin = false) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: randomBytes(6).toString("hex"),
      email: `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@gates.it`,
      displayName: name,
      deploymentAdmin,
    })
    .returning();
  return row;
}

type Role = "admin" | "member" | "viewer";
const appAs = (
  register: Parameters<typeof buildRouteTestApp>[0],
  id: string,
  workspaceId: string,
  workspaceRole: Role,
) => buildRouteTestApp(register, { user: { id, workspaceId, workspaceRole } });

const slug = () => `gates-${randomBytes(4).toString("hex")}`;

beforeEach(() => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("global secrets by default: a workspace admin's", () => {
  it("lets a workspace admin replace the organization's GitLab token", async () => {
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "");
    await deleteSecret("GITLAB_TOKEN", "global").catch(() => {});
    await storeSecret("GITLAB_TOKEN", "glpat-the-organizations", "global");
    const ws = await insertWorkspace();
    const bob = await insertUser("Bob");
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: bob.id, role: "admin" });
    const bobApp = await appAs(secretRoutes, bob.id, ws.id, "admin");
    const res = await bobApp.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "GITLAB_TOKEN", value: "glpat-bobs" },
    });
    expect(res.statusCode).toBe(201);
    expect(await retrieveSecret("GITLAB_TOKEN", "global")).toBe("glpat-bobs");

    // A member still may not (upstream's rule).
    const carol = await insertUser("Carol");
    const carolApp = await appAs(secretRoutes, carol.id, ws.id, "member");
    const refused = await carolApp.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "GITLAB_TOKEN", value: "glpat-carols" },
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe("global secrets under workspaces.creation=admins: a deployment admin's", () => {
  beforeEach(() => vi.stubEnv("OPTIO_WORKSPACE_CREATION", "admins"));

  it("403s a self-made workspace admin replacing the organization's GitLab token; 201 for a deployment admin", async () => {
    await deleteSecret("GITLAB_TOKEN", "global").catch(() => {});
    await storeSecret("GITLAB_TOKEN", "glpat-the-organizations", "global");

    // Bob made his own workspace, so he is its admin — and nothing more.
    const bobsWs = await insertWorkspace();
    const bob = await insertUser("Bob");
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: bobsWs.id, userId: bob.id, role: "admin" });
    const bobApp = await appAs(secretRoutes, bob.id, bobsWs.id, "admin");

    for (const payload of [
      { name: "GITLAB_TOKEN", value: "glpat-bobs" },
      { name: "GITLAB_TOKEN", value: "glpat-bobs", scope: "global" },
    ]) {
      const res = await bobApp.inject({ method: "POST", url: "/api/secrets", payload });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("Only a deployment admin changes organization-wide secrets");
    }
    for (const url of ["/api/secrets/GITLAB_TOKEN", "/api/secrets/GITLAB_TOKEN?scope=global"]) {
      expect((await bobApp.inject({ method: "DELETE", url })).statusCode).toBe(403);
    }
    expect(await retrieveSecret("GITLAB_TOKEN", "global")).toBe("glpat-the-organizations");

    // His own token is his to set.
    const own = await bobApp.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "GITLAB_TOKEN", value: "glpat-bobs-own", scope: "user" },
    });
    expect(own.statusCode).toBe(201);

    // A deployment admin may, from any workspace.
    const alice = await insertUser("Alice", true);
    const aliceApp = await appAs(secretRoutes, alice.id, bobsWs.id, "member");
    const res = await aliceApp.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: "GITLAB_TOKEN", value: "glpat-rotated" },
    });
    expect(res.statusCode).toBe(201);
    expect(await retrieveSecret("GITLAB_TOKEN", "global")).toBe("glpat-rotated");
    const [row] = await db
      .select()
      .from(secrets)
      .where(
        and(eq(secrets.name, "GITLAB_TOKEN"), eq(secrets.scope, "global"), isNull(secrets.userId)),
      );
    expect(row.workspaceId).toBeNull();
  });

  it("counts OPTIO_DEPLOYMENT_ADMINS emails too", async () => {
    const ws = await insertWorkspace();
    const ops = await insertUser("Ops");
    vi.stubEnv("OPTIO_DEPLOYMENT_ADMINS", ops.email);
    const app = await buildRouteTestApp(secretRoutes, {
      user: { id: ops.id, workspaceId: ws.id, workspaceRole: "admin", email: ops.email } as never,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/secrets",
      payload: { name: `GATES_IT_${randomBytes(3).toString("hex").toUpperCase()}`, value: "v" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("403s an organization agent credential (a global secret) for a workspace admin", async () => {
    const before = await retrieveSecret("ANTHROPIC_API_KEY", "global").catch(() => null);
    const ws = await insertWorkspace();
    const bob = await insertUser("Bob");
    const app = await appAs(agentCredentialRoutes, bob.id, ws.id, "admin");
    const res = await app.inject({
      method: "POST",
      url: "/api/agents/credentials",
      payload: {
        agentType: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        value: "sk-ant-x",
        owner: "workspace",
        verify: false,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/deployment admin/);
    // The 403 stops the handler: nothing is stored after it.
    await new Promise((r) => setTimeout(r, 300));
    expect(await retrieveSecret("ANTHROPIC_API_KEY", "global").catch(() => null)).toBe(before);
  });

  it("stores an organization agent credential for a deployment admin (201)", async () => {
    const before = await retrieveSecret("ANTHROPIC_API_KEY", "global").catch(() => null);
    const ws = await insertWorkspace();
    const alice = await insertUser("Alice", true);
    const app = await appAs(agentCredentialRoutes, alice.id, ws.id, "admin");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents/credentials",
        payload: {
          agentType: "claude-code",
          secretName: "ANTHROPIC_API_KEY",
          value: "sk-ant-gates-it",
          owner: "workspace",
          verify: false,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().credential.owner).toBe("workspace");
      expect(await retrieveSecret("ANTHROPIC_API_KEY", "global")).toBe("sk-ant-gates-it");
    } finally {
      if (before) await storeSecret("ANTHROPIC_API_KEY", before, "global");
      else await deleteSecret("ANTHROPIC_API_KEY", "global").catch(() => {});
    }
  });

  it("lets a deployment admin delete a global secret (204)", async () => {
    const name = `GATES_IT_DEL_${randomBytes(3).toString("hex").toUpperCase()}`;
    await storeSecret(name, "v", "global");
    const ws = await insertWorkspace();
    const bob = await insertUser("Bob");
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: bob.id, role: "admin" });
    const bobApp = await appAs(secretRoutes, bob.id, ws.id, "admin");
    const alice = await insertUser("Alice", true);
    const aliceApp = await appAs(secretRoutes, alice.id, ws.id, "member");

    expect(
      (await bobApp.inject({ method: "DELETE", url: `/api/secrets/${name}?scope=global` }))
        .statusCode,
    ).toBe(403);
    expect(await retrieveSecret(name, "global")).toBe("v");
    const res = await aliceApp.inject({
      method: "DELETE",
      url: `/api/secrets/${name}?scope=global`,
    });
    expect(res.statusCode, res.body).toBe(204);
    await expect(retrieveSecret(name, "global")).rejects.toThrow();
  });
});

describe("rotating the GitHub token (a global secret) under workspaces.creation=admins", () => {
  beforeEach(() => vi.stubEnv("OPTIO_WORKSPACE_CREATION", "admins"));
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("403s a workspace admin; a deployment admin goes on to the token check", async () => {
    // The check calls GitHub: answered here, so nothing leaves the machine.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 401 }));
    const ws = await insertWorkspace();
    const bob = await insertUser("Bob");
    const bobApp = await appAs(githubTokenRoutes, bob.id, ws.id, "admin");
    const rotate = (app: typeof bobApp) =>
      app.inject({
        method: "POST",
        url: "/api/github-token/rotate",
        payload: { token: "ghp_gates_it" },
      });

    const refused = await rotate(bobApp);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("Only a deployment admin changes organization-wide secrets");
    expect(fetchSpy).not.toHaveBeenCalled();

    // Upstream's own gate still applies: a deployment admin must also be a workspace admin.
    const alice = await insertUser("Alice", true);
    const asMember = await rotate(await appAs(githubTokenRoutes, alice.id, ws.id, "member"));
    expect(asMember.statusCode).toBe(403);
    expect(asMember.json().error).toBe("Admin role required");

    const passed = await rotate(await appAs(githubTokenRoutes, alice.id, ws.id, "admin"));
    expect(passed.statusCode).toBe(200);
    expect(passed.json()).toMatchObject({ success: false, error: expect.stringMatching(/401/) });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("creating a workspace", () => {
  it("is everyone's by default", async () => {
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "");
    const home = await insertWorkspace();
    const bob = await insertUser("Bob");
    const bobApp = await appAs(workspaceRoutes, bob.id, home.id, "member");
    const made = await bobApp.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Bob's", slug: slug() },
    });
    expect(made.statusCode).toBe(201);
  });

  it("is a deployment admin's under `admins`", async () => {
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "admins");
    const home = await insertWorkspace();
    const bob = await insertUser("Bob");
    const bobApp = await appAs(workspaceRoutes, bob.id, home.id, "member");
    const refused = await bobApp.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Bob's", slug: slug() },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/Only a deployment admin creates workspaces/);

    const alice = await insertUser("Alice", true);
    const aliceApp = await appAs(workspaceRoutes, alice.id, home.id, "member");
    const made = await aliceApp.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Platform", slug: slug(), accessGroups: ["platform-devs"] },
    });
    expect(made.statusCode).toBe(201);
    const id = made.json().workspace.id as string;

    // The action log has it.
    let logged: Array<{ action: string }> = [];
    for (let i = 0; i < 20 && logged.length === 0; i++) {
      logged = await db
        .select({ action: optioActions.action })
        .from(optioActions)
        .where(and(eq(optioActions.workspaceId, id), eq(optioActions.action, "workspace.create")));
      if (logged.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(logged).toHaveLength(1);
  });

  it("is everyone's when the deployment says so, but groups stay a deployment admin's", async () => {
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "everyone");
    const home = await insertWorkspace();
    const bob = await insertUser("Bob");
    const bobApp = await appAs(workspaceRoutes, bob.id, home.id, "member");
    const made = await bobApp.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Bob's", slug: slug() },
    });
    expect(made.statusCode).toBe(201);
    const withGroups = await bobApp.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Bob's other", slug: slug(), accessGroups: ["everyone-in-ad"] },
    });
    expect(withGroups.statusCode).toBe(403);
    expect(withGroups.json().error).toBe(
      "Only a deployment admin opens a workspace to directory groups",
    );
  });

  it("follows the app's setting over the environment", async () => {
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "admins");
    const home = await insertWorkspace();
    const bob = await insertUser("Bob");
    const bobApp = await appAs(workspaceRoutes, bob.id, home.id, "member");
    await setDeploymentSetting("workspaces.creation", "everyone", null);
    try {
      const made = await bobApp.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Bob's", slug: slug() },
      });
      expect(made.statusCode).toBe(201);
    } finally {
      await setDeploymentSetting("workspaces.creation", null, null);
    }
  });
});

describe("opening a workspace to directory groups", () => {
  it("403s a workspace admin who isn't a deployment admin; lets a deployment admin", async () => {
    const ws = await insertWorkspace({ accessGroups: ["devs"], accessGroupsRole: "member" });
    const bob = await insertUser("Bob");
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: bob.id, role: "admin" });
    const bobApp = await appAs(workspaceRoutes, bob.id, ws.id, "admin");
    const patch = (app: typeof bobApp, payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/api/workspaces/${ws.id}`, payload });

    for (const payload of [
      { accessGroups: ["devs", "all-staff"] },
      { accessGroups: [] },
      { accessGroupsRole: "viewer" },
    ]) {
      const res = await patch(bobApp, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(403);
      expect(res.json().error).toBe(
        "Only a deployment admin opens a workspace to directory groups",
      );
    }
    // Resending what is there, or changing something else, is still his.
    expect((await patch(bobApp, { accessGroups: ["DEVS"], name: "Renamed" })).statusCode).toBe(200);

    const alice = await insertUser("Alice", true);
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: alice.id, role: "admin" });
    const aliceApp = await appAs(workspaceRoutes, alice.id, ws.id, "admin");
    expect((await patch(aliceApp, { accessGroups: ["devs", "all-staff"] })).statusCode).toBe(200);
    const [row] = await db
      .select({ accessGroups: workspaces.accessGroups })
      .from(workspaces)
      .where(eq(workspaces.id, ws.id));
    expect(row.accessGroups).toEqual(["all-staff", "devs"]);
  });
});

describe("GET / PUT /api/deployment-settings", () => {
  it("shows a member what they may do; only a deployment admin changes it", async () => {
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "admins");
    const ws = await insertWorkspace();
    const bob = await insertUser("Bob");
    const alice = await insertUser("Alice", true);
    const bobApp = await appAs(deploymentSettingsRoutes, bob.id, ws.id, "admin");
    const aliceApp = await appAs(deploymentSettingsRoutes, alice.id, ws.id, "member");

    const seen = await bobApp.inject({ method: "GET", url: "/api/deployment-settings" });
    expect(seen.json()).toEqual({
      workspaceCreation: { value: "admins", source: "environment", environment: "admins" },
      teams: { value: false, source: "environment", environment: false },
      mergeConfirmation: { value: false, source: "environment", environment: false },
      onboarding: { value: false, source: "environment", environment: false },
      canEdit: false,
      mayCreateWorkspace: false,
    });
    const refused = await bobApp.inject({
      method: "PUT",
      url: "/api/deployment-settings",
      payload: { workspaceCreation: "everyone" },
    });
    expect(refused.statusCode).toBe(403);
    // The 403 stops the handler: the setting is still the deployment's.
    await new Promise((r) => setTimeout(r, 300));
    expect(
      (await bobApp.inject({ method: "GET", url: "/api/deployment-settings" })).json()
        .workspaceCreation,
    ).toEqual({ value: "admins", source: "environment", environment: "admins" });

    try {
      const changed = await aliceApp.inject({
        method: "PUT",
        url: "/api/deployment-settings",
        payload: { workspaceCreation: "everyone" },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().workspaceCreation).toEqual({
        value: "everyone",
        source: "app",
        environment: "admins",
      });
      expect(
        (await bobApp.inject({ method: "GET", url: "/api/deployment-settings" })).json()
          .mayCreateWorkspace,
      ).toBe(true);
    } finally {
      const back = await aliceApp.inject({
        method: "PUT",
        url: "/api/deployment-settings",
        payload: { workspaceCreation: null },
      });
      expect(back.json().workspaceCreation.source).toBe("environment");
    }
  });
});

describe("the teams and automatic-merge switches", () => {
  it("are off by default; a deployment admin turns them on, and null follows the deployment", async () => {
    vi.stubEnv("OPTIO_TEAMS_ENABLED", "");
    vi.stubEnv("OPTIO_MERGE_CONFIRMATION", "");
    const ws = await insertWorkspace();
    const bob = await insertUser("Bob");
    const alice = await insertUser("Alice", true);
    const bobApp = await appAs(deploymentSettingsRoutes, bob.id, ws.id, "admin");
    const aliceApp = await appAs(deploymentSettingsRoutes, alice.id, ws.id, "member");

    expect(await teamsEnabled()).toBe(false);
    expect(await mergeConfirmationRequired()).toBe(false);

    const refused = await bobApp.inject({
      method: "PUT",
      url: "/api/deployment-settings",
      payload: { teams: true },
    });
    expect(refused.statusCode).toBe(403);

    try {
      const on = await aliceApp.inject({
        method: "PUT",
        url: "/api/deployment-settings",
        payload: { teams: true, mergeConfirmation: true },
      });
      expect(on.statusCode).toBe(200);
      expect(on.json()).toMatchObject({
        teams: { value: true, source: "app", environment: false },
        mergeConfirmation: { value: true, source: "app", environment: false },
      });
      expect(await teamsEnabled()).toBe(true);
      expect(await mergeConfirmationRequired()).toBe(true);
    } finally {
      const back = await aliceApp.inject({
        method: "PUT",
        url: "/api/deployment-settings",
        payload: { teams: null, mergeConfirmation: null },
      });
      expect(back.json()).toMatchObject({
        teams: { value: false, source: "environment" },
        mergeConfirmation: { value: false, source: "environment" },
      });
    }
    expect(await teamsEnabled()).toBe(false);
    // The environment turns them on too.
    vi.stubEnv("OPTIO_TEAMS_ENABLED", "true");
    expect(await teamsEnabled()).toBe(true);
  });
});

describe("the getting-started guide switch", () => {
  it("is off by default; a deployment admin turns it on, and null follows the deployment", async () => {
    vi.stubEnv("OPTIO_ONBOARDING", "");
    const ws = await insertWorkspace();
    const bob = await insertUser("Bob");
    const alice = await insertUser("Alice", true);
    const bobApp = await appAs(deploymentSettingsRoutes, bob.id, ws.id, "admin");
    const aliceApp = await appAs(deploymentSettingsRoutes, alice.id, ws.id, "member");

    expect(await onboardingEnabled()).toBe(false);
    const seen = await bobApp.inject({ method: "GET", url: "/api/deployment-settings" });
    expect(seen.json().onboarding).toEqual({
      value: false,
      source: "environment",
      environment: false,
    });

    const refused = await bobApp.inject({
      method: "PUT",
      url: "/api/deployment-settings",
      payload: { onboarding: true },
    });
    expect(refused.statusCode).toBe(403);

    try {
      const on = await aliceApp.inject({
        method: "PUT",
        url: "/api/deployment-settings",
        payload: { onboarding: true },
      });
      expect(on.statusCode).toBe(200);
      expect(on.json().onboarding).toEqual({ value: true, source: "app", environment: false });
      // The other switches stay as they were.
      expect(on.json().teams.value).toBe(false);
      expect(await onboardingEnabled()).toBe(true);
    } finally {
      const back = await aliceApp.inject({
        method: "PUT",
        url: "/api/deployment-settings",
        payload: { onboarding: null },
      });
      expect(back.json().onboarding).toMatchObject({ value: false, source: "environment" });
    }
    expect(await onboardingEnabled()).toBe(false);
    // The deployment's own default (chart onboarding.enabled) turns it on too.
    vi.stubEnv("OPTIO_ONBOARDING", "true");
    expect(await onboardingEnabled()).toBe(true);
    expect(
      (await bobApp.inject({ method: "GET", url: "/api/deployment-settings" })).json().onboarding,
    ).toEqual({ value: true, source: "environment", environment: true });
  });
});
