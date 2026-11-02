/**
 * A deployment-wide route takes a deployment admin, whatever their role in
 * the workspace they are in right now. Real Postgres and the real auth
 * plugin: a deployment admin who is a member (not an admin) of their
 * workspace lists the ticket providers and restores the starter prompts; a
 * workspace admin who isn't a deployment admin still can't.
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { createApiKey } from "../services/api-key-service.js";
import { foundingWorkspaceId } from "../services/founding-workspace.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { ticketRoutes } from "./tickets.js";
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
      email: `${randomBytes(4).toString("hex")}@member.it`,
      emailVerified: true,
      displayName: "it",
      defaultWorkspaceId: ws,
      deploymentAdmin,
    })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws, userId: u.id, role });
  return { authorization: `Bearer ${(await createApiKey(u.id, "it")).token}` };
}

let founding: string;
let foreign: string;

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  founding = (await foundingWorkspaceId()) ?? (await insertWorkspace()).id;
  foreign = (await insertWorkspace()).id;
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(ticketRoutes);
  await app.register(promptTemplateRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (savedAuth === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = savedAuth;
  if (savedAdmins === undefined) delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  else process.env.OPTIO_DEPLOYMENT_ADMINS = savedAdmins;
});

describe("a deployment admin who is a member of their workspace", () => {
  it("lists the ticket providers and restores the starter prompts", async () => {
    const headers = await person(foreign, "member", true);
    const list = await app.inject({ method: "GET", url: "/api/tickets/providers", headers });
    expect(list.statusCode).toBe(200);
    const seed = await app.inject({ method: "POST", url: "/api/prompt-templates/seed", headers });
    expect(seed.statusCode).toBe(200);
  });
});

describe("a workspace admin who is not a deployment admin", () => {
  it("is still refused, in their own workspace and in the founding one", async () => {
    // Someone holds the role, so no founding-workspace admin stands in for it.
    await person(founding, "admin", true);
    for (const headers of [await person(foreign, "admin"), await person(founding, "member")]) {
      const list = await app.inject({ method: "GET", url: "/api/tickets/providers", headers });
      expect(list.statusCode).toBe(403);
      const seed = await app.inject({ method: "POST", url: "/api/prompt-templates/seed", headers });
      expect(seed.statusCode).toBe(403);
    }
  });
});
