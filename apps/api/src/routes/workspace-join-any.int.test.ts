/**
 * `deployment-admins.join-any-workspace` (Settings → Access), against real
 * Postgres and the real auth plugin. Off — the default — a deployment admin
 * gets into a workspace only as everyone does: the directory and the join
 * are refused and nothing else changes. On, a deployment admin sees every
 * workspace and joins any as an admin (an ordinary membership); nobody else
 * gains anything.
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { createApiKey } from "../services/api-key-service.js";
import {
  DEPLOYMENT_ADMINS_JOIN_ANY,
  forgetSwitches,
  setDeploymentSetting,
} from "../services/deployment-settings.js";
import { getUserRole } from "../services/workspace-service.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { workspaceRoutes } from "./workspaces.js";
import { deploymentSettingsRoutes } from "./deployment-settings.js";

let app: FastifyInstance;
const saved = {
  auth: process.env.OPTIO_AUTH_DISABLED,
  admins: process.env.OPTIO_DEPLOYMENT_ADMINS,
  env: process.env.OPTIO_DEPLOYMENT_ADMINS_JOIN_ANY_WORKSPACE,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  delete process.env.OPTIO_DEPLOYMENT_ADMINS_JOIN_ANY_WORKSPACE;
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(workspaceRoutes);
  await app.register(deploymentSettingsRoutes);
  await app.ready();
});

afterEach(async () => {
  await setDeploymentSetting(DEPLOYMENT_ADMINS_JOIN_ANY.key, null, null);
  forgetSwitches();
});

afterAll(async () => {
  await app?.close();
  restore("OPTIO_AUTH_DISABLED", saved.auth);
  restore("OPTIO_DEPLOYMENT_ADMINS", saved.admins);
  restore("OPTIO_DEPLOYMENT_ADMINS_JOIN_ANY_WORKSPACE", saved.env);
});

async function person(ws: string, role: "admin" | "member" | "viewer", deploymentAdmin = false) {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(5).toString("hex")}`,
      email: `${randomBytes(4).toString("hex")}@join.it`,
      emailVerified: true,
      displayName: "it",
      defaultWorkspaceId: ws,
      deploymentAdmin,
    })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws, userId: u.id, role });
  return {
    id: u.id,
    headers: { authorization: `Bearer ${(await createApiKey(u.id, "it")).token}` },
  };
}

async function turnOn(headers: Record<string, string>) {
  const res = await app.inject({
    method: "PUT",
    url: "/api/deployment-settings",
    headers,
    payload: { deploymentAdminsJoinAnyWorkspace: true },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().deploymentAdminsJoinAnyWorkspace).toEqual({
    value: true,
    source: "app",
    environment: false,
  });
  forgetSwitches();
}

describe("off (the default)", () => {
  it("leaves a deployment admin outside a workspace they aren't a member of", async () => {
    const home = (await insertWorkspace()).id;
    const other = (await insertWorkspace()).id;
    const admin = await person(home, "admin", true);

    const settings = await app.inject({
      method: "GET",
      url: "/api/deployment-settings",
      headers: admin.headers,
    });
    expect(settings.json().deploymentAdminsJoinAnyWorkspace.value).toBe(false);

    const dir = await app.inject({
      method: "GET",
      url: "/api/workspaces/directory",
      headers: admin.headers,
    });
    expect(dir.statusCode).toBe(403);
    const join = await app.inject({
      method: "POST",
      url: `/api/workspaces/${other}/join`,
      headers: admin.headers,
    });
    expect(join.statusCode).toBe(403);
    expect(await getUserRole(other, admin.id)).toBeNull();

    // Exactly main's behaviour around it: their list, the switch and the header.
    const list = await app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: admin.headers,
    });
    expect(list.json().workspaces.map((w: { id: string }) => w.id)).toEqual([home]);
    const sw = await app.inject({
      method: "POST",
      url: `/api/workspaces/${other}/switch`,
      headers: admin.headers,
    });
    expect(sw.statusCode).toBe(403);
    const scoped = await app.inject({
      method: "GET",
      url: `/api/workspaces/${other}`,
      headers: { ...admin.headers, "x-workspace-id": other },
    });
    expect(scoped.statusCode).toBe(403);
  });
});

describe("on", () => {
  it("lets a deployment admin see every workspace and join one as an admin", async () => {
    const home = (await insertWorkspace()).id;
    const other = (await insertWorkspace()).id;
    const admin = await person(home, "member", true);
    await person(other, "admin");
    await turnOn(admin.headers);

    const dir = await app.inject({
      method: "GET",
      url: "/api/workspaces/directory",
      headers: admin.headers,
    });
    expect(dir.statusCode).toBe(200);
    const rows = dir.json().workspaces as Array<{
      id: string;
      role: string | null;
      members: number;
    }>;
    expect(rows.find((w) => w.id === home)).toMatchObject({ role: "member", members: 1 });
    expect(rows.find((w) => w.id === other)).toMatchObject({ role: null, members: 1 });

    const join = await app.inject({
      method: "POST",
      url: `/api/workspaces/${other}/join`,
      headers: admin.headers,
    });
    expect(join.statusCode).toBe(200);
    expect(join.json().result).toBe("joined");
    expect(await getUserRole(other, admin.id)).toBe("admin");

    // An ordinary membership: they switch to it, act there and show in its members list.
    const sw = await app.inject({
      method: "POST",
      url: `/api/workspaces/${other}/switch`,
      headers: admin.headers,
    });
    expect(sw.statusCode).toBe(200);
    const members = await app.inject({
      method: "GET",
      url: `/api/workspaces/${other}/members`,
      headers: { ...admin.headers, "x-workspace-id": other },
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().members.map((m: { userId: string }) => m.userId)).toContain(admin.id);

    // Their own workspace: a member's role raised to admin, once.
    const raise = await app.inject({
      method: "POST",
      url: `/api/workspaces/${home}/join`,
      headers: admin.headers,
    });
    expect(raise.json().result).toBe("raised");
    expect(await getUserRole(home, admin.id)).toBe("admin");
    const again = await app.inject({
      method: "POST",
      url: `/api/workspaces/${home}/join`,
      headers: admin.headers,
    });
    expect(again.json().result).toBe("unchanged");
  });

  it("works for a deployment admin who is a viewer where they stand", async () => {
    const home = (await insertWorkspace()).id;
    const other = (await insertWorkspace()).id;
    const admin = await person(home, "viewer", true);
    await turnOn((await person(home, "admin", true)).headers);
    const join = await app.inject({
      method: "POST",
      url: `/api/workspaces/${other}/join`,
      headers: admin.headers,
    });
    expect(join.statusCode).toBe(200);
    expect(await getUserRole(other, admin.id)).toBe("admin");
  });

  it("gives nobody else anything, a workspace admin included", async () => {
    const home = (await insertWorkspace()).id;
    const other = (await insertWorkspace()).id;
    await turnOn((await person(home, "admin", true)).headers);
    for (const role of ["admin", "member", "viewer"] as const) {
      const someone = await person(home, role);
      const dir = await app.inject({
        method: "GET",
        url: "/api/workspaces/directory",
        headers: someone.headers,
      });
      expect(dir.statusCode).toBe(403);
      const join = await app.inject({
        method: "POST",
        url: `/api/workspaces/${other}/join`,
        headers: someone.headers,
      });
      expect(join.statusCode).toBe(403);
      expect(await getUserRole(other, someone.id)).toBeNull();
    }
  });

  it("answers 404 for a workspace that doesn't exist", async () => {
    const home = (await insertWorkspace()).id;
    const admin = await person(home, "admin", true);
    await turnOn(admin.headers);
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces/00000000-0000-4000-8000-000000000000/join",
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("follows the environment's default when nothing is saved", async () => {
    const home = (await insertWorkspace()).id;
    const admin = await person(home, "admin", true);
    process.env.OPTIO_DEPLOYMENT_ADMINS_JOIN_ANY_WORKSPACE = "true";
    forgetSwitches();
    try {
      const dir = await app.inject({
        method: "GET",
        url: "/api/workspaces/directory",
        headers: admin.headers,
      });
      expect(dir.statusCode).toBe(200);
    } finally {
      delete process.env.OPTIO_DEPLOYMENT_ADMINS_JOIN_ANY_WORKSPACE;
      forgetSwitches();
    }
  });
});
