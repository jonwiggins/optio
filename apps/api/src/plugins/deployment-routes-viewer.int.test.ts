/**
 * The deployment-wide routes answer to the deployment admin role, not to the
 * role someone holds in the workspace they happen to be in. Real Postgres and
 * the real auth plugin: the viewer baseline ("mutating requests need at least
 * a member") must not stop a deployment admin who is a viewer here from
 * changing the deployment's settings, nor a person with the setup token from
 * claiming the role while nobody holds it. Everyone else stays read-only.
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import authPlugin from "./auth.js";
import { createApiKey } from "../services/api-key-service.js";
import { getDeploymentSetting, setDeploymentSetting } from "../services/deployment-settings.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { deploymentSettingsRoutes } from "../routes/deployment-settings.js";
import { signInRoutes } from "../routes/sign-in.js";
import { promptTemplateRoutes } from "../routes/prompt-templates.js";

const SETUP_TOKEN = "it-setup-token-0123456789abcdef";
let app: FastifyInstance;
const saved = {
  auth: process.env.OPTIO_AUTH_DISABLED,
  admins: process.env.OPTIO_DEPLOYMENT_ADMINS,
  token: process.env.OPTIO_SETUP_TOKEN,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  process.env.OPTIO_SETUP_TOKEN = SETUP_TOKEN;
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(deploymentSettingsRoutes);
  await app.register(signInRoutes);
  await app.register(promptTemplateRoutes);
  app.post("/api/probe/mutate", async () => ({ ok: true }));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  restore("OPTIO_AUTH_DISABLED", saved.auth);
  restore("OPTIO_DEPLOYMENT_ADMINS", saved.admins);
  restore("OPTIO_SETUP_TOKEN", saved.token);
});

async function person(opts: { ws?: string; role?: "admin" | "member" | "viewer"; da?: boolean }) {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(5).toString("hex")}`,
      email: `${randomBytes(4).toString("hex")}@viewer.it`,
      emailVerified: true,
      displayName: "it",
      defaultWorkspaceId: opts.ws ?? null,
      deploymentAdmin: !!opts.da,
    })
    .returning();
  if (opts.ws && opts.role) {
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: opts.ws, userId: u.id, role: opts.role });
  }
  return {
    id: u.id,
    headers: { authorization: `Bearer ${(await createApiKey(u.id, "it")).token}` },
  };
}

describe("claiming the deployment admin role with the setup token", () => {
  it("works for a viewer and for someone in no workspace yet, while nobody holds the role", async () => {
    // Under `admins`, a newcomer who no domain lets in belongs to no workspace.
    await setDeploymentSetting("workspaces.creation", "admins", null);
    const ws = (await insertWorkspace()).id;
    const viewer = await person({ ws, role: "viewer" });
    const newcomer = await person({});

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/deployment-admins/claim",
      headers: { ...newcomer.headers, "x-optio-setup-token": SETUP_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, newcomer.id));
    expect(row.deploymentAdmin).toBe(true);

    // Now someone holds it: the viewer's claim is the route's to refuse (403), with its reason.
    const late = await app.inject({
      method: "POST",
      url: "/api/auth/deployment-admins/claim",
      headers: { ...viewer.headers, "x-optio-setup-token": SETUP_TOKEN },
    });
    expect(late.statusCode).toBe(403);
    expect(late.json().error).toMatch(/already has a deployment admin/);
    await setDeploymentSetting("workspaces.creation", null, null);
  });
});

describe("a deployment admin who is a viewer in their workspace", () => {
  it("changes the deployment settings and the deployment admins, and restores the starter prompts", async () => {
    const ws = (await insertWorkspace()).id;
    const admin = await person({ ws, role: "viewer", da: true });
    const other = await person({ ws, role: "viewer" });

    const put = await app.inject({
      method: "PUT",
      url: "/api/deployment-settings",
      headers: admin.headers,
      payload: { onboarding: true },
    });
    expect(put.statusCode).toBe(200);
    expect(await getDeploymentSetting("onboarding.enabled")).toBe(true);

    const add = await app.inject({
      method: "POST",
      url: "/api/auth/deployment-admins",
      headers: admin.headers,
      payload: { userId: other.id },
    });
    expect(add.statusCode).toBeLessThan(300);
    await setDeploymentSetting("onboarding.enabled", null, null);
  });

  it("is still a viewer on the workspace's own routes", async () => {
    const ws = (await insertWorkspace()).id;
    const admin = await person({ ws, role: "viewer", da: true });
    const res = await app.inject({
      method: "POST",
      url: "/api/probe/mutate",
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("a viewer who is not a deployment admin", () => {
  it("stays read-only on the deployment-wide routes", async () => {
    const ws = (await insertWorkspace()).id;
    const viewer = await person({ ws, role: "viewer" });
    const put = await app.inject({
      method: "PUT",
      url: "/api/deployment-settings",
      headers: viewer.headers,
      payload: { onboarding: true },
    });
    expect(put.statusCode).toBe(403);
    const add = await app.inject({
      method: "POST",
      url: "/api/auth/deployment-admins",
      headers: viewer.headers,
      payload: { userId: viewer.id },
    });
    expect(add.statusCode).toBe(403);
    const seed = await app.inject({
      method: "POST",
      url: "/api/prompt-templates/seed",
      headers: viewer.headers,
    });
    expect(seed.statusCode).toBe(403);
    expect(await getDeploymentSetting("onboarding.enabled")).toBeUndefined();
  });
});
