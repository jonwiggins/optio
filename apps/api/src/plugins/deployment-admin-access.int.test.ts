/**
 * Deployment admins as admins of every workspace (the
 * `deployment-admins.all-workspaces` switch: Settings → Access over Helm's
 * `OPTIO_DEPLOYMENT_ADMINS_ALL_WORKSPACES`), against the real auth plugin, the
 * workspace routes, Postgres and Redis: off, nothing changes; on, a
 * deployment admin acts as admin in any workspace — ones they don't belong to
 * and ones they belong to with a lower role — sees them all in their list,
 * shows in each workspace's members list and leaves a daily entry in its
 * activity log, while nobody else gains anything and their own private
 * secrets stay out of other workspaces' admins' reach (membership, not the
 * grant, decides who is *in* a workspace).
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { optioActions, users } from "../db/schema.js";
import authPlugin from "./auth.js";
import { createApiKey } from "../services/api-key-service.js";
import * as workspaceService from "../services/workspace-service.js";
import { retrieveSecret, storeSecret } from "../services/secret-service.js";
import { canMessageTask } from "../services/task-message-service.js";
import { workspaceRoutes } from "../routes/workspaces.js";
import { secretRoutes } from "../routes/secrets.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import {
  DEPLOYMENT_ADMINS_ALL_WORKSPACES,
  forgetSwitches,
  setDeploymentSetting,
} from "../services/deployment-settings.js";
import { DEPLOYMENT_ADMIN_ACCESS_ACTION } from "../services/deployment-admin-audit.js";

const SWITCH = "OPTIO_DEPLOYMENT_ADMINS_ALL_WORKSPACES";
let app: FastifyInstance;
const saved = {
  authDisabled: process.env.OPTIO_AUTH_DISABLED,
  admins: process.env.OPTIO_DEPLOYMENT_ADMINS,
  allWorkspaces: process.env[SWITCH],
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  delete process.env[SWITCH];
  forgetSwitches();
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  app.get("/api/probe/whoami", async (req) => ({
    workspaceId: req.user?.workspaceId ?? null,
    role: req.user?.workspaceRole ?? null,
  }));
  app.post("/api/probe/mutate", async () => ({ ok: true }));
  await workspaceRoutes(app);
  await app.ready();
});

afterEach(async () => {
  delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  delete process.env[SWITCH];
  await setDeploymentSetting(DEPLOYMENT_ADMINS_ALL_WORKSPACES.key, null, null);
  forgetSwitches();
});

/** The deployment's default (Helm), as a test sets it: the switch is remembered for a few seconds. */
function helmDefault(on: boolean) {
  process.env[SWITCH] = on ? "true" : "false";
  forgetSwitches();
}

/** What a deployment admin saves in Settings → Access (null: follow the deployment). */
async function appSetting(on: boolean | null) {
  await setDeploymentSetting(DEPLOYMENT_ADMINS_ALL_WORKSPACES.key, on, null);
  forgetSwitches();
}

afterAll(async () => {
  await app.close();
  restore("OPTIO_AUTH_DISABLED", saved.authDisabled);
  restore("OPTIO_DEPLOYMENT_ADMINS", saved.admins);
  restore(SWITCH, saved.allWorkspaces);
});

const tag = () => randomBytes(4).toString("hex");

async function person(
  name: string,
  opts: { deploymentAdmin?: boolean; emailVerified?: boolean } = {},
) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${tag()}`,
      email: `${name}-${tag()}@acme.test`,
      emailVerified: opts.emailVerified ?? true,
      displayName: name,
      deploymentAdmin: opts.deploymentAdmin ?? false,
    })
    .returning();
  return { ...row, pat: (await createApiKey(row.id, "laptop")).token };
}

/** A workspace with its own admin, which the deployment admin isn't in. */
async function team(name = "Team") {
  const admin = await person(`${name.toLowerCase()}-admin`);
  const ws = await workspaceService.createWorkspace({ name, slug: `t-${tag()}` }, admin.id);
  return { id: ws.id, admin };
}

const bearer = (pat: string, workspaceId?: string) => ({
  authorization: `Bearer ${pat}`,
  ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
});

describe("with the switch off (the default)", () => {
  it("leaves a deployment admin with only their memberships", async () => {
    const t = await team();
    const optio = await person("optio", { deploymentAdmin: true });

    expect(await workspaceService.getUserRole(t.id, optio.id)).toBeNull();
    const asked = await app.inject({
      url: "/api/probe/whoami",
      headers: bearer(optio.pat, t.id),
    });
    expect(asked.statusCode).toBe(403);
    const listed = await workspaceService.listUserWorkspaces(optio.id);
    expect(listed.map((w) => w.id)).not.toContain(t.id);
  });
});

describe("with the switch on (Helm default true)", () => {
  it("makes a deployment admin admin of a workspace they don't belong to", async () => {
    helmDefault(true);
    const t = await team();
    const optio = await person("optio", { deploymentAdmin: true });

    expect(await workspaceService.getUserRole(t.id, optio.id)).toBe("admin");
    expect(await workspaceService.getMembershipRole(t.id, optio.id)).toBeNull();

    const who = await app.inject({ url: "/api/probe/whoami", headers: bearer(optio.pat, t.id) });
    expect(who.json()).toEqual({ workspaceId: t.id, role: "admin" });
    const write = await app.inject({
      method: "POST",
      url: "/api/probe/mutate",
      headers: bearer(optio.pat, t.id),
    });
    expect(write.statusCode).toBe(200);

    // Admin-only workspace routes: settings and members.
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${t.id}`,
      headers: bearer(optio.pat, t.id),
      payload: { name: "Renamed by the Optio admin" },
    });
    expect(renamed.statusCode).toBe(200);
    const newcomer = await person("newcomer");
    const added = await app.inject({
      method: "POST",
      url: `/api/workspaces/${t.id}/members`,
      headers: bearer(optio.pat, t.id),
      payload: { userId: newcomer.id, role: "member" },
    });
    expect(added.statusCode).toBe(201);

    // It's a role, not a membership: they don't show up as a member.
    const members = await workspaceService.listMembers(t.id);
    expect(members.map((m) => m.userId)).not.toContain(optio.id);
  });

  it("lets them switch to any workspace and lists every one, marked", async () => {
    helmDefault(true);
    const optio = await person("optio", { deploymentAdmin: true });
    const own = await workspaceService.createWorkspace(
      { name: "Own", slug: `o-${tag()}` },
      optio.id,
    );
    const viewing = await team("Viewing");
    await workspaceService.addMember(viewing.id, optio.id, "viewer");
    const other = await team("Other");

    const listed = await workspaceService.listUserWorkspaces(optio.id);
    const byId = new Map(listed.map((w) => [w.id, w]));
    expect(byId.get(own.id)).toMatchObject({ role: "admin" });
    expect(byId.get(own.id)?.viaDeploymentAdmin).toBeUndefined();
    // A lower membership is lifted to admin, and says where admin comes from.
    expect(byId.get(viewing.id)).toMatchObject({ role: "admin", viaDeploymentAdmin: true });
    expect(byId.get(other.id)).toMatchObject({ role: "admin", viaDeploymentAdmin: true });
    // Memberships first, then the rest.
    const at = (id: string) => listed.findIndex((w) => w.id === id);
    expect(Math.max(at(own.id), at(viewing.id))).toBeLessThan(at(other.id));
    expect(await workspaceService.getUserRole(viewing.id, optio.id)).toBe("admin");

    const switched = await app.inject({
      method: "POST",
      url: `/api/workspaces/${other.id}/switch`,
      headers: bearer(optio.pat),
    });
    expect(switched.statusCode).toBe(200);
    const who = await app.inject({ url: "/api/probe/whoami", headers: bearer(optio.pat) });
    expect(who.json()).toEqual({ workspaceId: other.id, role: "admin" });
  });

  it("lets them message any task in the workspace, like its admins", async () => {
    helmDefault(true);
    const t = await team();
    const optio = await person("optio", { deploymentAdmin: true });
    expect(await canMessageTask(optio.id, { createdBy: t.admin.id, workspaceId: t.id })).toBe(true);
  });

  it("gives nobody else anything, and no workspace that doesn't exist", async () => {
    helmDefault(true);
    const t = await team();
    const stranger = await person("stranger");
    expect(await workspaceService.getUserRole(t.id, stranger.id)).toBeNull();
    const asked = await app.inject({
      url: "/api/probe/whoami",
      headers: bearer(stranger.pat, t.id),
    });
    expect(asked.statusCode).toBe(403);
    expect((await workspaceService.listUserWorkspaces(stranger.id)).map((w) => w.id)).not.toContain(
      t.id,
    );
    // A workspace admin is still only admin of their own workspaces.
    const elsewhere = await team("Elsewhere");
    expect(await workspaceService.getUserRole(elsewhere.id, t.admin.id)).toBeNull();

    const optio = await person("optio", { deploymentAdmin: true });
    const missing = "00000000-0000-4000-8000-00000000dead";
    expect(await workspaceService.getUserRole(missing, optio.id)).toBeNull();
  });

  it("counts an OPTIO_DEPLOYMENT_ADMINS email only when its provider verified it", async () => {
    helmDefault(true);
    const t = await team();
    const verified = await person("listed");
    const unverified = await person("listed-unverified", { emailVerified: false });
    process.env.OPTIO_DEPLOYMENT_ADMINS = `${verified.email.toUpperCase()},${unverified.email}`;

    expect(await workspaceService.getUserRole(t.id, verified.id)).toBe("admin");
    expect(await workspaceService.getUserRole(t.id, unverified.id)).toBeNull();
  });

  it("takes the access away with the role", async () => {
    helmDefault(true);
    const t = await team();
    const optio = await person("optio", { deploymentAdmin: true });
    expect(await workspaceService.getUserRole(t.id, optio.id)).toBe("admin");

    await db.update(users).set({ deploymentAdmin: false }).where(eq(users.id, optio.id));
    expect(await workspaceService.getUserRole(t.id, optio.id)).toBeNull();
    const asked = await app.inject({ url: "/api/probe/whoami", headers: bearer(optio.pat, t.id) });
    expect(asked.statusCode).toBe(403);
  });

  it("keeps a deployment admin's private secrets out of other workspaces' admins' reach", async () => {
    helmDefault(true);
    const t = await team();
    const optio = await person("optio", { deploymentAdmin: true });
    const name = `OPTIO_ADMIN_KEY_${tag().toUpperCase()}`;
    await storeSecret(name, "v", "user", null, optio.id);

    // The team's admin (who anyone can become, by creating a workspace) names
    // the deployment admin as the owner: not a member of the team, so 404.
    const teamAdmin = await buildRouteTestApp(secretRoutes, {
      user: { id: t.admin.id, workspaceId: t.id, workspaceRole: "admin" },
    });
    const del = await teamAdmin.inject({
      method: "DELETE",
      url: `/api/secrets/${name}?scope=user&userId=${optio.id}`,
    });
    expect(del.statusCode).toBe(404);
    expect(await retrieveSecret(name, "user", undefined, optio.id)).toBe("v");
    await teamAdmin.close();
  });
});

describe("Settings → Access over the Helm default", () => {
  it("lets the app setting win either way, and null follow the deployment again", async () => {
    const t = await team();
    const optio = await person("optio", { deploymentAdmin: true });

    helmDefault(false);
    await appSetting(true);
    expect(await workspaceService.getUserRole(t.id, optio.id)).toBe("admin");

    helmDefault(true);
    await appSetting(false);
    expect(await workspaceService.getUserRole(t.id, optio.id)).toBeNull();
    expect((await workspaceService.listUserWorkspaces(optio.id)).map((w) => w.id)).not.toContain(
      t.id,
    );

    await appSetting(null);
    expect(await workspaceService.getUserRole(t.id, optio.id)).toBe("admin");
  });
});

describe("the members list", () => {
  it("shows every deployment admin who can act in the workspace, member or not, while on", async () => {
    helmDefault(true);
    const t = await team();
    const outsider = await person("optio", { deploymentAdmin: true });
    const viewer = await person("optio-viewer", { deploymentAdmin: true });
    await workspaceService.addMember(t.id, viewer.id, "viewer");

    const listed = await app.inject({
      url: `/api/workspaces/${t.id}/members`,
      headers: bearer(t.admin.pat, t.id),
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as {
      members: Array<{ userId: string }>;
      deploymentAdmins: Array<{ userId: string; email: string; membershipRole: string | null }>;
    };
    const admin = (id: string) => body.deploymentAdmins.find((a) => a.userId === id);
    expect(admin(outsider.id)).toMatchObject({ email: outsider.email, membershipRole: null });
    expect(admin(viewer.id)).toMatchObject({ membershipRole: "viewer" });
    expect(admin(t.admin.id)).toBeUndefined();
    expect(body.members.map((m) => m.userId)).not.toContain(outsider.id);

    helmDefault(false);
    const off = await app.inject({
      url: `/api/workspaces/${t.id}/members`,
      headers: bearer(t.admin.pat, t.id),
    });
    expect(off.json().deploymentAdmins).toEqual([]);
  });
});

describe("the workspace's activity log", () => {
  const entries = (workspaceId: string, userId: string) =>
    db
      .select({ id: optioActions.id, result: optioActions.result })
      .from(optioActions)
      .where(
        and(
          eq(optioActions.workspaceId, workspaceId),
          eq(optioActions.userId, userId),
          eq(optioActions.action, DEPLOYMENT_ADMIN_ACCESS_ACTION),
        ),
      );
  /** The entry is written without holding up the request: wait for it briefly. */
  async function settle(workspaceId: string, userId: string) {
    for (let i = 0; i < 60; i++) {
      if ((await entries(workspaceId, userId)).length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 100));
    return entries(workspaceId, userId);
  }

  it("records a deployment admin's access through the grant once a day, and nothing for members", async () => {
    helmDefault(true);
    const t = await team();
    const optio = await person("optio", { deploymentAdmin: true });
    const own = await workspaceService.createWorkspace(
      { name: "Own", slug: `o-${tag()}` },
      optio.id,
    );

    for (let i = 0; i < 3; i++) {
      const asked = await app.inject({
        url: "/api/probe/whoami",
        headers: bearer(optio.pat, t.id),
      });
      expect(asked.json()).toEqual({ workspaceId: t.id, role: "admin" });
    }
    const logged = await settle(t.id, optio.id);
    expect(logged).toHaveLength(1);
    expect(logged[0].result).toMatchObject({ role: "admin", via: "deployment_admin" });

    // Their own workspace (an admin membership) and the team's own admin: no entry.
    await app.inject({ url: "/api/probe/whoami", headers: bearer(optio.pat, own.id) });
    await app.inject({ url: "/api/probe/whoami", headers: bearer(t.admin.pat, t.id) });
    await new Promise((r) => setTimeout(r, 300));
    expect(await entries(own.id, optio.id)).toHaveLength(0);
    expect(await entries(t.id, t.admin.id)).toHaveLength(0);

    // A new day writes a new entry.
    const { noteDeploymentAdminAccess } = await import("../services/deployment-admin-audit.js");
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(await noteDeploymentAdminAccess(t.id, optio.id, tomorrow)).toBe(true);
    expect(await noteDeploymentAdminAccess(t.id, optio.id, tomorrow)).toBe(false);
    expect(await entries(t.id, optio.id)).toHaveLength(2);
  });
});
