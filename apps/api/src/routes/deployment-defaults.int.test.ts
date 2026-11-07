/**
 * Deployment-wide defaults: the Optio settings row with no workspace and the
 * default prompts with no workspace, which every workspace without its own
 * reads. Real Postgres and the real auth plugin: only a deployment admin
 * reads or saves them (whatever their role in their current workspace); a
 * workspace admin is refused; a workspace's own values still win; a new
 * workspace starts from the deployment's, and one with nothing of its own
 * follows later changes to them.
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { createApiKey } from "../services/api-key-service.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { optioSettingsRoutes } from "./optio-settings.js";
import { promptTemplateRoutes } from "./prompt-templates.js";

let app: FastifyInstance;
const savedAuth = process.env.OPTIO_AUTH_DISABLED;
const savedAdmins = process.env.OPTIO_DEPLOYMENT_ADMINS;

async function person(ws: string, role: "admin" | "member" | "viewer", deploymentAdmin = false) {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(5).toString("hex")}`,
      email: `${randomBytes(4).toString("hex")}@defaults.it`,
      emailVerified: true,
      displayName: "it",
      defaultWorkspaceId: ws,
      deploymentAdmin,
    })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws, userId: u.id, role });
  return { authorization: `Bearer ${(await createApiKey(u.id, "it")).token}` };
}

type Headers = { authorization: string };
const get = (url: string, headers: Headers) => app.inject({ method: "GET", url, headers });
const putSettings = (headers: Headers, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/api/optio/settings", headers, payload });
const savePrompt = (headers: Headers, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/prompt-templates", headers, payload });

let deploymentAdmin: Headers;
let workspaceAdmin: Headers;

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(optioSettingsRoutes);
  await app.register(promptTemplateRoutes);
  await app.ready();
  // A deployment admin who is only a member of their workspace, and an admin
  // of another workspace who isn't one. Someone holds the role, so no
  // founding-workspace admin stands in for it.
  deploymentAdmin = await person((await insertWorkspace()).id, "member", true);
  workspaceAdmin = await person((await insertWorkspace()).id, "admin");
});

afterAll(async () => {
  await app?.close();
  if (savedAuth === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = savedAuth;
  if (savedAdmins === undefined) delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  else process.env.OPTIO_DEPLOYMENT_ADMINS = savedAdmins;
});

describe("deployment-wide defaults", () => {
  it("start out as the built-in ones, for everyone (checked first)", async () => {
    const mine = await get("/api/optio/settings", workspaceAdmin);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().source).toBe("builtin");
    const deployment = await get("/api/optio/settings?scope=deployment", deploymentAdmin);
    expect(deployment.json().source).toBe("builtin");
    const prompt = await get("/api/prompt-templates/effective?scope=workspace", workspaceAdmin);
    expect(prompt.json().source).toBe("builtin");
  });

  it("are refused to a workspace admin who isn't a deployment admin, read and write", async () => {
    for (const res of [
      await get("/api/optio/settings?scope=deployment", workspaceAdmin),
      await putSettings(workspaceAdmin, { scope: "deployment", maxTurns: 7 }),
      await get("/api/prompt-templates/effective?scope=deployment", workspaceAdmin),
      await get("/api/prompt-templates/review-default?scope=deployment", workspaceAdmin),
      await savePrompt(workspaceAdmin, { scope: "deployment", template: "Theirs" }),
      await savePrompt(workspaceAdmin, { scope: "deployment", template: "Theirs", isReview: true }),
    ]) {
      expect(res.statusCode).toBe(403);
    }
    // Nothing was saved for the deployment.
    const deployment = await get("/api/optio/settings?scope=deployment", deploymentAdmin);
    expect(deployment.json().source).toBe("builtin");
  });

  it("are saved and read back by a deployment admin who is a member of their workspace", async () => {
    const saved = await putSettings(deploymentAdmin, {
      scope: "deployment",
      systemPrompt: "Deployment additions",
      maxTurns: 30,
      confirmWrites: false,
      defaultReviewModel: null,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().source).toBe("deployment");
    expect(saved.json().settings.workspaceId).toBeNull();
    expect(
      (await savePrompt(deploymentAdmin, { scope: "deployment", template: "Dep coding" }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await savePrompt(deploymentAdmin, {
          scope: "deployment",
          template: "Dep review",
          isReview: true,
        })
      ).statusCode,
    ).toBe(201);

    const settings = (await get("/api/optio/settings?scope=deployment", deploymentAdmin)).json();
    expect(settings.source).toBe("deployment");
    expect(settings.settings).toMatchObject({ systemPrompt: "Deployment additions", maxTurns: 30 });
    const prompt = (
      await get("/api/prompt-templates/effective?scope=deployment", deploymentAdmin)
    ).json();
    expect(prompt).toMatchObject({ template: "Dep coding", source: "deployment" });
    const review = (
      await get("/api/prompt-templates/review-default?scope=deployment", deploymentAdmin)
    ).json();
    expect(review).toEqual({ template: "Dep review", source: "deployment" });
  });

  it("are what a new workspace starts from", async () => {
    const fresh = await person((await insertWorkspace()).id, "member");
    const settings = (await get("/api/optio/settings", fresh)).json();
    expect(settings.source).toBe("deployment");
    expect(settings.settings).toMatchObject({ systemPrompt: "Deployment additions", maxTurns: 30 });
    const prompt = (await get("/api/prompt-templates/effective?scope=workspace", fresh)).json();
    expect(prompt).toMatchObject({ template: "Dep coding", source: "deployment" });
    // The unscoped reads (what agents and older clients use) resolve the same way.
    expect((await get("/api/prompt-templates/effective", fresh)).json().template).toBe(
      "Dep coding",
    );
    expect((await get("/api/prompt-templates/review-default", fresh)).json()).toEqual({
      template: "Dep review",
    });
  });

  it("give way to a workspace's own values, which a deployment change leaves alone", async () => {
    const ownWs = (await insertWorkspace()).id;
    const own = await person(ownWs, "admin");
    const followerWs = (await insertWorkspace()).id;
    const follower = await person(followerWs, "member");

    const saved = await putSettings(own, { maxTurns: 12 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().source).toBe("workspace");
    expect((await savePrompt(own, { template: "Ours" })).statusCode).toBe(201);
    const mine = (await get("/api/optio/settings", own)).json();
    expect(mine.source).toBe("workspace");
    // The first save kept the deployment's other values (#742).
    expect(mine.settings).toMatchObject({ maxTurns: 12, systemPrompt: "Deployment additions" });
    expect(
      (await get("/api/prompt-templates/effective?scope=workspace", own)).json(),
    ).toMatchObject({
      template: "Ours",
      source: "workspace",
    });

    // The deployment admin changes the defaults later.
    expect(
      (
        await putSettings(deploymentAdmin, {
          scope: "deployment",
          systemPrompt: "Changed",
          maxTurns: 40,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await savePrompt(deploymentAdmin, { scope: "deployment", template: "Dep v2" })).statusCode,
    ).toBe(201);

    // A workspace with nothing of its own follows them...
    const followed = (await get("/api/optio/settings", follower)).json();
    expect(followed.source).toBe("deployment");
    expect(followed.settings).toMatchObject({ systemPrompt: "Changed", maxTurns: 40 });
    expect((await get("/api/prompt-templates/effective", follower)).json().template).toBe("Dep v2");
    // ...and one with its own keeps them.
    const kept = (await get("/api/optio/settings", own)).json();
    expect(kept.settings).toMatchObject({ maxTurns: 12, systemPrompt: "Deployment additions" });
    expect((await get("/api/prompt-templates/effective", own)).json().template).toBe("Ours");
    // The workspace admin's own save never touched the deployment's row.
    const deployment = (await get("/api/optio/settings?scope=deployment", deploymentAdmin)).json();
    expect(deployment.settings).toMatchObject({ systemPrompt: "Changed", maxTurns: 40 });
  });

  it("a scoped read of a repo's prompt is a bad request", async () => {
    const res = await get(
      "/api/prompt-templates/effective?scope=workspace&repoUrl=https://github.com/o/r",
      workspaceAdmin,
    );
    expect(res.statusCode).toBe(400);
  });
});
