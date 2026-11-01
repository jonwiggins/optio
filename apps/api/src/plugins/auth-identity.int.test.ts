/**
 * Who a request is and which workspace it acts in, against the real auth
 * plugin and Postgres: a removed member keeps no access (and is never
 * promoted), `workspaces.creation = admins` gives a newcomer nothing of
 * their own, a domain is an admin's own only when their email is verified,
 * and every path decision is made on the route the router matched — raw
 * request targets over a real socket, since `inject` normalizes them.
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, workspaceMembers } from "../db/schema.js";
import authPlugin, { NO_WORKSPACE_ERROR } from "./auth.js";
import { createApiKey } from "../services/api-key-service.js";
import { createSession } from "../services/session-service.js";
import * as workspaceService from "../services/workspace-service.js";
import { setDeploymentSetting } from "../services/deployment-settings.js";
import { workspaceRoutes } from "../routes/workspaces.js";

let app: FastifyInstance;
let port = 0;
const savedAuthDisabled = process.env.OPTIO_AUTH_DISABLED;
const savedAdmins = process.env.OPTIO_DEPLOYMENT_ADMINS;

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  const whoami = async (req: {
    user?: { workspaceId: string | null; workspaceRole: string | null };
  }) => ({
    workspaceId: req.user?.workspaceId ?? null,
    role: req.user?.workspaceRole ?? null,
  });
  app.get("/api/probe/whoami", whoami);
  app.get("/api/auth/me", whoami);
  app.post("/api/probe/mutate", async () => ({ ok: true }));
  app.get("/api/health", async () => ({ ok: true }));
  app.post("/api/hooks/:webhookPath", async () => ({ hook: true }));
  await workspaceRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await app.close();
  if (savedAuthDisabled === undefined) delete process.env.OPTIO_AUTH_DISABLED;
  else process.env.OPTIO_AUTH_DISABLED = savedAuthDisabled;
  if (savedAdmins === undefined) delete process.env.OPTIO_DEPLOYMENT_ADMINS;
  else process.env.OPTIO_DEPLOYMENT_ADMINS = savedAdmins;
});

beforeEach(async () => {
  await setDeploymentSetting("workspaces.creation", null, null);
});

const ext = () => `it-${randomBytes(6).toString("hex")}`;

async function person(email: string, emailVerified = true) {
  const externalId = ext();
  const [row] = await db
    .insert(users)
    .values({ provider: "github", externalId, email, emailVerified, displayName: email })
    .returning();
  return { ...row, externalId, pat: (await createApiKey(row.id, "laptop")).token };
}

async function organization(): Promise<{ id: string; adminPat: string }> {
  const admin = await person(`admin-${randomBytes(3).toString("hex")}@acme.test`);
  const ws = await workspaceService.createWorkspace(
    { name: "Org", slug: `org-${randomBytes(4).toString("hex")}` },
    admin.id,
  );
  return { id: ws.id, adminPat: admin.pat };
}

const bearer = (pat: string, workspaceId?: string) => ({
  authorization: `Bearer ${pat}`,
  ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
});

describe("a removed member", () => {
  it("keeps no access to the workspace through a PAT, a fresh session, or a stale default", async () => {
    const org = await organization();
    const leaver = await person("leaver@acme.test");
    await workspaceService.addMember(org.id, leaver.id, "viewer");
    await workspaceService.switchWorkspace(leaver.id, org.id);

    let who = await app.inject({ url: "/api/probe/whoami", headers: bearer(leaver.pat) });
    expect(who.json()).toEqual({ workspaceId: org.id, role: "viewer" });

    await workspaceService.removeMember(org.id, leaver.id);
    const [row] = await db.select().from(users).where(eq(users.id, leaver.id));
    expect(row.defaultWorkspaceId).not.toBe(org.id);

    who = await app.inject({ url: "/api/probe/whoami", headers: bearer(leaver.pat) });
    expect(who.json().workspaceId).not.toBe(org.id);

    const { token } = await createSession("github", {
      externalId: leaver.externalId,
      email: leaver.email,
      displayName: "L",
    });
    const fresh = await app.inject({
      url: "/api/probe/whoami",
      headers: { cookie: `optio_session=${token}` },
    });
    expect(fresh.json().workspaceId).not.toBe(org.id);

    const asked = await app.inject({
      method: "POST",
      url: "/api/probe/mutate",
      headers: bearer(leaver.pat, org.id),
    });
    expect(asked.statusCode).toBe(403);
  });

  it("falls back to a workspace they still belong to, with that membership's own role", async () => {
    const org = await organization();
    const other = await organization();
    const leaver = await person("two-workspaces@acme.test");
    await workspaceService.addMember(other.id, leaver.id, "viewer");
    await workspaceService.addMember(org.id, leaver.id, "member");
    await workspaceService.switchWorkspace(leaver.id, org.id);
    // A default still pointing at a workspace they're no longer in (rows from
    // before removeMember cleared it, or a membership deleted another way).
    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, org.id), eq(workspaceMembers.userId, leaver.id)));

    const who = await app.inject({ url: "/api/probe/whoami", headers: bearer(leaver.pat) });
    expect(who.json()).toEqual({ workspaceId: other.id, role: "viewer" });
    const write = await app.inject({
      method: "POST",
      url: "/api/probe/mutate",
      headers: bearer(leaver.pat),
    });
    expect(write.statusCode).toBe(403);
  });
});

describe("workspaces.creation = admins", () => {
  it("gives a newcomer no workspace of their own: who they are, and a 403 that says to ask", async () => {
    await setDeploymentSetting("workspaces.creation", "admins", null);
    const newcomer = await person(`rando-${randomBytes(3).toString("hex")}@example.test`);

    const create = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: bearer(newcomer.pat),
      payload: { name: "Mine", slug: `mine-${randomBytes(3).toString("hex")}` },
    });
    expect(create.statusCode).toBe(403);

    const me = await app.inject({ url: "/api/auth/me", headers: bearer(newcomer.pat) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ workspaceId: null, role: null });

    const list = await app.inject({ url: "/api/workspaces", headers: bearer(newcomer.pat) });
    expect(list.json()).toEqual({ workspaces: [] });

    const work = await app.inject({ url: "/api/probe/whoami", headers: bearer(newcomer.pat) });
    expect(work.statusCode).toBe(403);
    expect(work.json()).toEqual({ error: NO_WORKSPACE_ERROR, details: "no_workspace" });

    expect(await workspaceService.listUserWorkspaces(newcomer.id)).toEqual([]);
  });

  it("still lets people in by their verified email's domain, and gives a deployment admin one", async () => {
    await setDeploymentSetting("workspaces.creation", "admins", null);
    const domain = `corp${randomBytes(3).toString("hex")}.test`;
    const org = await organization();
    await workspaceService.updateWorkspace(org.id, { autoJoinDomains: [domain] });
    const employee = await person(`dev@${domain}`);
    await workspaceService.joinWorkspacesByEmailDomain(employee.id, employee.email, true);
    const who = await app.inject({ url: "/api/probe/whoami", headers: bearer(employee.pat) });
    expect(who.json()).toEqual({ workspaceId: org.id, role: "member" });

    const opsEmail = `ops-${randomBytes(3).toString("hex")}@acme.test`;
    process.env.OPTIO_DEPLOYMENT_ADMINS = opsEmail;
    try {
      const ops = await person(opsEmail);
      const mine = await app.inject({ url: "/api/probe/whoami", headers: bearer(ops.pat) });
      expect(mine.json().role).toBe("admin");
    } finally {
      delete process.env.OPTIO_DEPLOYMENT_ADMINS;
    }
  });

  it("under the default (everyone), a newcomer still gets a workspace of their own", async () => {
    const newcomer = await person(`fresh-${randomBytes(3).toString("hex")}@example.test`);
    const who = await app.inject({ url: "/api/probe/whoami", headers: bearer(newcomer.pat) });
    expect(who.json().role).toBe("admin");
  });
});

describe("auto-join by the admin's own domain", () => {
  it("counts a domain as the admin's own only when their email is verified", async () => {
    for (const verified of [false, true]) {
      const domain = `victim${randomBytes(3).toString("hex")}.test`;
      const admin = await person(`ceo@${domain}`, verified);
      const ws = await workspaceService.createWorkspace(
        { name: "Trap", slug: `trap-${randomBytes(4).toString("hex")}` },
        admin.id,
      );
      const res = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${ws.id}`,
        headers: bearer(admin.pat, ws.id),
        payload: { autoJoinDomains: [domain] },
      });
      expect(res.statusCode, `verified=${verified}`).toBe(verified ? 200 : 403);
    }
  });
});

/** One raw HTTP/1.1 request: the status line and body, target exactly as given. */
function send(method: string, target: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const lines = Object.entries({ Host: "x", "Content-Length": "0", ...headers }).map(
        ([k, v]) => `${k}: ${v}`,
      );
      socket.write(
        `${method} ${target} HTTP/1.1\r\n${lines.join("\r\n")}\r\nConnection: close\r\n\r\n`,
      );
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const [head, body = ""] = data.split("\r\n\r\n");
      resolve({ status: Number(head.split(" ")[1]), body });
    });
  });
}

describe("the request target a decision is made on", () => {
  it("holds a viewer read-only however the path is spelled", async () => {
    const org = await organization();
    const viewer = await person("viewer@acme.test");
    await workspaceService.addMember(org.id, viewer.id, "viewer");
    const auth = { Authorization: `Bearer ${viewer.pat}`, "X-Workspace-Id": org.id };

    expect((await send("POST", "/api/probe/mutate", auth)).status).toBe(403);
    // Percent-encoding reaches the same handler: the same rule applies.
    const encoded = await send("POST", "/%61pi/probe/mutate", auth);
    expect(encoded.status).toBe(403);
    expect(encoded.body).toMatch(/read-only/);
    expect((await send("POST", "/api/probe/mutat%65", auth)).status).toBe(403);
    // An absolute-form target is refused outright, credentials or not.
    expect((await send("POST", `http://127.0.0.1:${port}/api/probe/mutate`, auth)).status).toBe(
      400,
    );
    expect(
      (await send("POST", "http://x/api/probe/mutate", { Authorization: "Bearer optio_pat_bogus" }))
        .status,
    ).toBe(400);
    // A member is unaffected.
    const member = await person("member@acme.test");
    await workspaceService.addMember(org.id, member.id, "member");
    expect(
      (
        await send("POST", "/%61pi/probe/mutate", {
          Authorization: `Bearer ${member.pat}`,
          "X-Workspace-Id": org.id,
        })
      ).status,
    ).toBe(200);
  });

  it("never makes a protected route public through a public-looking spelling", async () => {
    // Without credentials, every spelling of a protected route asks for them…
    for (const target of [
      "/api/probe/whoami",
      "/%61pi/probe/whoami",
      "/api/hooks/../probe/whoami",
      "/api/hooks/%2e%2e/probe/whoami",
      "/ws/../api/probe/whoami",
      "/docs/../api/probe/whoami",
    ]) {
      const res = await send("GET", target);
      expect([401, 404], target).toContain(res.status);
      expect(res.body, target).not.toMatch(/workspaceId/);
    }
    // …and public routes stay public, spelled either way.
    expect((await send("GET", "/api/health")).status).toBe(200);
    expect((await send("GET", "/%61pi/health")).status).toBe(200);
    expect((await send("POST", "/api/hooks/some-path")).status).toBe(200);
  });
});
