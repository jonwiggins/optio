/**
 * Workspaces as code against a real database, through the real auth plugin
 * and PATs: a deployment admin creates workspaces with members and repos
 * from manifests, a dry run writes nothing, a second apply changes nothing,
 * members the file doesn't list stay unless it says `prune: true`, nobody
 * gets in by an unverified email, and an export applies back unchanged.
 * Workspace admins and members are refused, and a Workspace manifest sent to
 * the workspace-level apply is an error item, not a workspace.
 */
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { ConfigApplyResult, ConfigPlanItem } from "@optio/shared";
import { db } from "../db/client.js";
import { optioActions, repos, users, workspaceMembers, workspaces } from "../db/schema.js";
import authPlugin from "../plugins/auth.js";
import { createApiKey } from "../services/api-key-service.js";
import { foundingWorkspaceId } from "../services/founding-workspace.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { configRoutes } from "./config.js";
import { configWorkspaceRoutes } from "./config-workspaces.js";

let app: FastifyInstance;
const savedAuth = process.env.OPTIO_AUTH_DISABLED;
const tag = randomBytes(3).toString("hex");
const slug = (name: string) => `${name}-${tag}`;

async function account(
  email: string,
  opts: { verified?: boolean; deploymentAdmin?: boolean } = {},
) {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(5).toString("hex")}`,
      email,
      emailVerified: opts.verified ?? true,
      displayName: email,
      deploymentAdmin: !!opts.deploymentAdmin,
    })
    .returning();
  return u;
}

async function caller(ws: string, role: "admin" | "member", deploymentAdmin = false) {
  const u = await account(`${randomBytes(4).toString("hex")}@example.org`, { deploymentAdmin });
  await db.update(users).set({ defaultWorkspaceId: ws }).where(eq(users.id, u.id));
  await db.insert(workspaceMembers).values({ workspaceId: ws, userId: u.id, role });
  return {
    id: u.id,
    headers: { authorization: `Bearer ${(await createApiKey(u.id, "it")).token}` },
  };
}

const doc = (name: string, spec: Record<string, unknown>, description?: string) => ({
  path: `workspaces/${name}.yaml`,
  document: {
    apiVersion: "optio/v1",
    kind: "Workspace",
    metadata: { name, ...(description ? { description } : {}) },
    spec,
  },
});

let founding: string;
let admin: { id: string; headers: Record<string, string> };
let workspaceAdmin: { headers: Record<string, string> };
let member: { headers: Record<string, string> };

async function apply(
  manifests: unknown[],
  dryRun = false,
  headers = admin.headers,
): Promise<{ status: number; body: ConfigApplyResult }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/config/workspaces/apply",
    headers,
    payload: { manifests, dryRun },
  });
  return { status: res.statusCode, body: res.json() };
}

const actions = (r: ConfigApplyResult) =>
  r.items.map((i: ConfigPlanItem) => `${i.action} ${i.kind}/${i.name}`).sort();

async function wsBySlug(s: string) {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.slug, s));
  return row;
}

async function roles(workspaceId: string) {
  const rows = await db
    .select({ email: users.email, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return Object.fromEntries(rows.map((r) => [r.email, r.role]));
}

beforeAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = "false";
  founding = (await foundingWorkspaceId()) ?? (await insertWorkspace()).id;
  admin = await caller(founding, "admin", true);
  // An admin of a workspace they made themselves: not a deployment admin.
  const own = (await insertWorkspace()).id;
  workspaceAdmin = await caller(own, "admin");
  member = await caller(founding, "member");
  await account(`lead-${tag}@example.com`);
  await account(`dev-${tag}@example.com`);
  await account(`ops-${tag}@example.com`);
  // Claims an address it never proved: an apply must not match it.
  await account(`unverified-${tag}@example.com`, { verified: false });
  app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(authPlugin);
  await app.register(configRoutes);
  await app.register(configWorkspaceRoutes);
  await app.ready();
});

afterAll(async () => {
  process.env.OPTIO_AUTH_DISABLED = savedAuth;
  await app?.close();
});

const payments = () =>
  doc(
    slug("payments"),
    {
      displayName: "Payments",
      settings: { restrictPodSecrets: true, autoJoinDomains: [] },
      members: [
        { email: `lead-${tag}@example.com`, role: "admin" },
        { email: `DEV-${tag}@example.com` },
        { email: `unverified-${tag}@example.com` },
        { email: `later-${tag}@example.com`, role: "viewer" },
      ],
      repos: [
        {
          url: `https://github.com/example-${tag}/payments-api`,
          defaultBranch: "develop",
          maxConcurrentTasks: 2,
        },
      ],
    },
    "The payments team",
  );

describe("workspace apply", () => {
  it("refuses everyone but a deployment admin", async () => {
    for (const headers of [workspaceAdmin.headers, member.headers]) {
      const res = await apply([payments()], false, headers);
      expect(res.status).toBe(403);
    }
    const exp = await app.inject({
      method: "GET",
      url: "/api/config/workspaces/export",
      headers: workspaceAdmin.headers,
    });
    expect(exp.statusCode).toBe(403);
    expect(await wsBySlug(slug("payments"))).toBeUndefined();
  });

  it("takes a deployment admin whatever their role in the workspace they're in", async () => {
    const asMember = await caller(founding, "member", true);
    const res = await apply([payments()], true, asMember.headers);
    expect(res.status).toBe(200);
    expect(await wsBySlug(slug("payments"))).toBeUndefined();
  });

  it("plans without writing, then creates the workspace, its members and repos", async () => {
    const plan = await apply([payments()], true);
    expect(plan.status).toBe(200);
    expect(plan.body.dryRun).toBe(true);
    expect(actions(plan.body)).toEqual(
      [
        `create Workspace/${slug("payments")}`,
        `create WorkspaceMember/lead-${tag}@example.com`,
        `create WorkspaceMember/DEV-${tag}@example.com`,
        `unchanged WorkspaceMember/unverified-${tag}@example.com`,
        `unchanged WorkspaceMember/later-${tag}@example.com`,
        `create Repo/https://github.com/example-${tag}/payments-api`,
      ].sort(),
    );
    expect(await wsBySlug(slug("payments"))).toBeUndefined();

    const done = await apply([payments()]);
    expect(done.status).toBe(200);
    expect(done.body.summary.errors).toBe(0);
    expect(actions(done.body)).toEqual(actions(plan.body));
    const ws = await wsBySlug(slug("payments"));
    expect(ws).toMatchObject({
      name: "Payments",
      description: "The payments team",
      restrictPodSecrets: true,
    });
    // The applier isn't made a member: the file says who is.
    expect(await roles(ws.id)).toEqual({
      [`lead-${tag}@example.com`]: "admin",
      [`dev-${tag}@example.com`]: "member",
    });
    const [repo] = await db.select().from(repos).where(eq(repos.workspaceId, ws.id));
    expect(repo).toMatchObject({ defaultBranch: "develop", maxConcurrentTasks: 2 });
    const waiting = done.body.items.find((i) => i.name === `later-${tag}@example.com`);
    expect(waiting?.message).toMatch(/signed in/);

    // Logged for the deployment and in the workspace it changed.
    const logged = await db
      .select()
      .from(optioActions)
      .where(eq(optioActions.action, "config.workspaces.apply"));
    expect(logged.some((a) => a.workspaceId === null && a.userId === admin.id)).toBe(true);
    expect(logged.some((a) => a.workspaceId === ws.id)).toBe(true);
  });

  it("changes nothing on a second apply", async () => {
    const again = await apply([payments()]);
    expect(again.body.summary).toMatchObject({ created: 0, updated: 0, pruned: 0, errors: 0 });
    expect(again.body.items.every((i) => i.action === "unchanged")).toBe(true);
  });

  it("updates what the file names and leaves the rest", async () => {
    const ws = await wsBySlug(slug("payments"));
    await db.update(workspaces).set({ allowDockerInDocker: true }).where(eq(workspaces.id, ws.id));
    const next = payments();
    const spec = next.document.spec as Record<string, any>;
    spec.displayName = "Payments Platform";
    spec.members[1].role = "admin";
    const res = await apply([next]);
    expect(res.body.summary.errors).toBe(0);
    const head = res.body.items.find((i) => i.kind === "Workspace");
    expect(head).toMatchObject({ action: "update", changes: ["displayName"] });
    const devItem = res.body.items.find((i) => i.name === `DEV-${tag}@example.com`);
    expect(devItem).toMatchObject({ action: "update", changes: ["role: member → admin"] });
    const after = await wsBySlug(slug("payments"));
    expect(after.name).toBe("Payments Platform");
    // A setting the file doesn't name keeps its value.
    expect(after.allowDockerInDocker).toBe(true);
    expect((await roles(ws.id))[`dev-${tag}@example.com`]).toBe("admin");
  });

  it("keeps members the file doesn't list unless it says prune: true", async () => {
    const ws = await wsBySlug(slug("payments"));
    const ops = (
      await db
        .select()
        .from(users)
        .where(eq(users.email, `ops-${tag}@example.com`))
    )[0];
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws.id, userId: ops.id, role: "member" });

    const kept = await apply([payments()]);
    expect(kept.body.summary.pruned).toBe(0);
    const head = kept.body.items.find((i) => i.kind === "Workspace");
    expect(head?.message).toContain(`ops-${tag}@example.com`);
    expect(await roles(ws.id)).toHaveProperty(`ops-${tag}@example.com`);

    const pruning = payments();
    (pruning.document.spec as Record<string, unknown>).prune = true;
    const plan = await apply([pruning], true);
    expect(plan.body.summary.pruned).toBe(1);
    expect(await roles(ws.id)).toHaveProperty(`ops-${tag}@example.com`);
    const pruned = await apply([pruning]);
    expect(pruned.body.items.find((i) => i.name === `ops-${tag}@example.com`)).toMatchObject({
      action: "prune",
    });
    expect(await roles(ws.id)).not.toHaveProperty(`ops-${tag}@example.com`);
    // The workspace and its repo are still there.
    expect(await db.select().from(repos).where(eq(repos.workspaceId, ws.id))).toHaveLength(1);
  });

  it("won't prune a workspace down to no admin", async () => {
    const ws = await wsBySlug(slug("payments"));
    const before = await roles(ws.id);
    const res = await apply([
      doc(slug("payments"), {
        members: [{ email: `later-${tag}@example.com`, role: "admin" }],
        prune: true,
      }),
    ]);
    expect(res.body.summary.errors).toBe(1);
    expect(res.body.summary.pruned).toBe(0);
    expect(await roles(ws.id)).toEqual(before);
  });

  it("never deletes a workspace that the file leaves out", async () => {
    const res = await apply([doc(slug("other"), { displayName: "Other" })]);
    expect(res.body.summary.errors).toBe(0);
    expect(await wsBySlug(slug("payments"))).toBeDefined();
  });

  it("reports a bad manifest alone and applies the rest", async () => {
    const res = await apply([
      doc("Not A Slug", {}),
      doc(slug("bad-domain"), { settings: { autoJoinDomains: ["not a domain"] } }),
      doc(slug("fine"), {}),
    ]);
    expect(res.body.summary.errors).toBe(2);
    expect(res.body.summary.created).toBe(1);
    expect(await wsBySlug(slug("fine"))).toBeDefined();
    expect(await wsBySlug(slug("bad-domain"))).toBeUndefined();
  });

  it("is refused by the workspace-level apply", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/config/apply",
      headers: admin.headers,
      payload: { manifests: [doc(slug("sneaky"), {})] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ action: "error" });
    expect(res.json().items[0].message).toMatch(/deployment/);
    expect(await wsBySlug(slug("sneaky"))).toBeUndefined();
  });
});

describe("workspace export", () => {
  it("writes what exists, and applying it changes nothing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/config/workspaces/export?slug=${slug("payments")},${slug("other")}`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(200);
    const { manifests } = res.json() as {
      manifests: Array<{ name: string; path: string; document: Record<string, any> }>;
    };
    expect(manifests.map((m) => m.path)).toEqual([
      `workspaces/${slug("other")}.yaml`,
      `workspaces/${slug("payments")}.yaml`,
    ]);
    const exported = manifests.find((m) => m.name === slug("payments"))!.document;
    // The prune test applied the original file again: dev is back to member.
    expect(exported.spec.members).toEqual([
      { email: `dev-${tag}@example.com`, role: "member" },
      { email: `lead-${tag}@example.com`, role: "admin" },
    ]);
    expect(exported.spec.prune).toBeUndefined();
    expect(exported.spec.repos[0]).toMatchObject({
      url: `https://github.com/example-${tag}/payments-api`,
      defaultBranch: "develop",
    });

    const yaml = await app.inject({
      method: "GET",
      url: `/api/config/workspaces/export.yaml?slug=${slug("payments")}`,
      headers: admin.headers,
    });
    const parsed = YAML.parseAllDocuments(yaml.body).map((d) => d.toJSON());
    expect(parsed[0]).toEqual(exported);

    const roundTrip = await apply(manifests.map((m) => ({ path: m.path, document: m.document })));
    expect(roundTrip.body.summary.errors).toBe(0);
    expect(roundTrip.body.items.every((i) => i.action === "unchanged")).toBe(true);
  });

  it("leaves out members with an unverified email", async () => {
    const ws = await wsBySlug(slug("payments"));
    const [u] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, `unverified-${tag}@example.com`), eq(users.emailVerified, false)));
    await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: u.id, role: "member" });
    const res = await app.inject({
      method: "GET",
      url: `/api/config/workspaces/export?slug=${slug("payments")}`,
      headers: admin.headers,
    });
    const emails = res
      .json()
      .manifests[0].document.spec.members.map((m: { email: string }) => m.email);
    expect(emails).not.toContain(`unverified-${tag}@example.com`);
  });
});
