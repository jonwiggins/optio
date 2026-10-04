/**
 * Organization and private scope against a real database — the one rule in
 * services/ownership.ts, applied to secrets, work of every kind, persistent
 * agents, MCP servers, skills and prompts: a private row is its owner's
 * alone, read-only to a workspace admin, and usable only by its owner's work.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { persistentAgents, secrets, users, workspaceMembers } from "../db/schema.js";
import {
  insertTask,
  insertTaskConfig,
  insertWorkflow,
  insertWorkflowRun,
  insertWorkspace,
} from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { canSee, canChange, type Actor } from "./ownership.js";
import {
  buildSecretAAD,
  encrypt,
  healWorkspaceBoundUserSecrets,
  listVisibleSecrets,
  resolvePodSecrets,
  retrieveSecret,
  storeSecret,
} from "./secret-service.js";
import { listWork, resolveWork } from "./work-service.js";
import { listPersistentAgents, getPersistentAgentScoped } from "./persistent-agent-service.js";
import { createMcpServer, getMcpServersForTask, listMcpServers } from "./mcp-server-service.js";
import { createSkill, getSkillsForTask, listSkills } from "./skill-service.js";
import { createNamedTemplate, listPromptTemplates } from "./prompt-template-service.js";
import { secretRoutes } from "../routes/secrets.js";
import { taskRoutes } from "../routes/tasks.js";

async function insertUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomBytes(6).toString("hex"),
      email: `${name.toLowerCase()}-${randomBytes(3).toString("hex")}@acme.dev`,
      displayName: name,
    })
    .returning();
  return row;
}

async function insertAgent(workspaceId: string, slug: string, ownerUserId: string | null) {
  const [row] = await db
    .insert(persistentAgents)
    .values({
      workspaceId,
      slug,
      name: slug,
      ownerUserId,
      initialPrompt: "You are an integration test agent.",
    })
    .returning();
  return row;
}

describe("organization and private scope", () => {
  let ws: string;
  let admin: Actor;
  let alice: Actor;
  let bob: Actor;

  beforeEach(async () => {
    ws = (await insertWorkspace()).id;
    const [a, b, c] = await Promise.all([
      insertUser("Ada"),
      insertUser("Alice"),
      insertUser("Bob"),
    ]);
    await db.insert(workspaceMembers).values([
      { workspaceId: ws, userId: a.id, role: "admin" },
      { workspaceId: ws, userId: b.id, role: "member" },
      { workspaceId: ws, userId: c.id, role: "member" },
    ]);
    admin = { workspaceId: ws, userId: a.id, isAdmin: true };
    alice = { workspaceId: ws, userId: b.id, isAdmin: false };
    bob = { workspaceId: ws, userId: c.id, isAdmin: false };
  });

  it("states the rule: owner alone, admins read-only, organization rows for everyone", () => {
    expect(canSee(null, bob)).toBe(true);
    expect(canSee(alice.userId, alice)).toBe(true);
    expect(canSee(alice.userId, bob)).toBe(false);
    expect(canSee(alice.userId, admin)).toBe(true);
    // Changing: the organization's by its role rule; a private row by its owner alone.
    expect(canChange(null, bob, false)).toBe(false);
    expect(canChange(null, admin, true)).toBe(true);
    expect(canChange(alice.userId, alice, false)).toBe(true);
    expect(canChange(alice.userId, admin, true, "edit")).toBe(false);
    expect(canChange(alice.userId, admin, true, "delete")).toBe(true);
  });

  describe("secrets", () => {
    it("stores a private secret so its owner's work can decrypt it, even when saved with a workspace", async () => {
      // What POST /api/secrets used to pass: the caller's workspace.
      await storeSecret("MY_TOKEN", "tok-alice", "user", ws, alice.userId);
      const [row] = await db
        .select()
        .from(secrets)
        .where(and(eq(secrets.name, "MY_TOKEN"), eq(secrets.userId, alice.userId!)));
      expect(row.workspaceId).toBeNull();
      expect(await retrieveSecret("MY_TOKEN", "user", undefined, alice.userId)).toBe("tok-alice");

      // Alice's work gets it; the organization's work and Bob's don't.
      const mine = await resolvePodSecrets(["MY_TOKEN"], {
        workspaceId: ws,
        ownerUserId: alice.userId,
      });
      expect(mine.env.MY_TOKEN).toBe("tok-alice");
      const org = await resolvePodSecrets(["MY_TOKEN"], { workspaceId: ws, ownerUserId: null });
      expect(org.missing).toEqual(["MY_TOKEN"]);
      const bobs = await resolvePodSecrets(["MY_TOKEN"], {
        workspaceId: ws,
        ownerUserId: bob.userId,
      });
      expect(bobs.missing).toEqual(["MY_TOKEN"]);
    });

    it("heals private secrets saved bound to a workspace before the fix", async () => {
      // A row as the old route wrote it: scope "user" with the workspace in the AAD.
      const blob = encrypt("old-value", buildSecretAAD("OLD_TOKEN", "user", ws));
      await db.insert(secrets).values({
        name: "OLD_TOKEN",
        scope: "user",
        workspaceId: ws,
        userId: alice.userId!,
        encryptedValue: blob.ciphertext,
        iv: blob.iv,
        authTag: blob.authTag,
        alg: blob.alg,
      });
      // Unreadable the way every reader looks it up…
      const before = await resolvePodSecrets(["OLD_TOKEN"], {
        workspaceId: ws,
        ownerUserId: alice.userId,
      });
      expect(before.missing).toEqual(["OLD_TOKEN"]);
      // …until healed.
      expect(await healWorkspaceBoundUserSecrets()).toBeGreaterThanOrEqual(1);
      const after = await resolvePodSecrets(["OLD_TOKEN"], {
        workspaceId: ws,
        ownerUserId: alice.userId,
      });
      expect(after.env.OLD_TOKEN).toBe("old-value");
      const [row] = await db
        .select({ workspaceId: secrets.workspaceId })
        .from(secrets)
        .where(and(eq(secrets.name, "OLD_TOKEN"), eq(secrets.userId, alice.userId!)));
      expect(row.workspaceId).toBeNull();
      // Idempotent.
      expect(await healWorkspaceBoundUserSecrets()).toBe(0);
    });

    it("lists the organization's and the viewer's own; admins also see members' private ones by name", async () => {
      await storeSecret("ORG_KEY", "v", "global", null, null);
      await storeSecret("REPO_KEY", "v", "https://github.com/acme/app", ws, null);
      await storeSecret("ALICE_KEY", "v", "user", null, alice.userId);
      await storeSecret("BOB_KEY", "v", "user", null, bob.userId);

      const names = (rows: Awaited<ReturnType<typeof listVisibleSecrets>>) =>
        rows.map((r) => `${r.name}${r.ownerName ? `:${r.ownerName}` : ""}`).sort();
      expect(names(await listVisibleSecrets(alice))).toEqual([
        "ALICE_KEY:Alice",
        "ORG_KEY",
        "REPO_KEY",
      ]);
      expect(names(await listVisibleSecrets(bob))).toEqual(["BOB_KEY:Bob", "ORG_KEY", "REPO_KEY"]);
      expect(names(await listVisibleSecrets(admin))).toEqual([
        "ALICE_KEY:Alice",
        "BOB_KEY:Bob",
        "ORG_KEY",
        "REPO_KEY",
      ]);
      // The scope filter narrows the same set.
      expect(names(await listVisibleSecrets(admin, "user"))).toEqual([
        "ALICE_KEY:Alice",
        "BOB_KEY:Bob",
      ]);
      expect(names(await listVisibleSecrets(bob, "global"))).toEqual(["ORG_KEY"]);
    });

    it("over HTTP: a member never sees another's private secret; an admin may delete one for offboarding", async () => {
      await storeSecret("ALICE_KEY", "v", "user", null, alice.userId);
      const as = (actor: Actor, role: "admin" | "member") =>
        buildRouteTestApp(secretRoutes, {
          user: { id: actor.userId!, workspaceId: ws, workspaceRole: role },
        });
      const bobApp = await as(bob, "member");
      const list = await bobApp.inject({ method: "GET", url: "/api/secrets" });
      expect(list.json().secrets.map((s: { name: string }) => s.name)).not.toContain("ALICE_KEY");

      // Bob deleting "ALICE_KEY" at user scope only ever targets his own (nothing).
      await bobApp.inject({ method: "DELETE", url: "/api/secrets/ALICE_KEY?scope=user" });
      expect(await retrieveSecret("ALICE_KEY", "user", undefined, alice.userId)).toBe("v");

      const adminApp = await as(admin, "admin");
      const seen = await adminApp.inject({ method: "GET", url: "/api/secrets" });
      const row = seen.json().secrets.find((s: { name: string }) => s.name === "ALICE_KEY");
      expect(row).toMatchObject({ ownerUserId: alice.userId, ownerName: "Alice" });
      const del = await adminApp.inject({
        method: "DELETE",
        url: `/api/secrets/ALICE_KEY?scope=user&userId=${alice.userId}`,
      });
      expect(del.statusCode).toBe(204);
      await expect(retrieveSecret("ALICE_KEY", "user", undefined, alice.userId)).rejects.toThrow();
    });
  });

  describe("work", () => {
    it("shows a member the organization's work and their own; an admin every row, named", async () => {
      await insertTask({ workspaceId: ws, title: "org task" });
      await insertTask({ workspaceId: ws, title: "alice task", ownerUserId: alice.userId });
      await insertTaskConfig({
        workspaceId: ws,
        name: "alice schedule",
        ownerUserId: alice.userId,
      });
      const job = await insertWorkflow({
        workspaceId: ws,
        name: "alice job",
        ownerUserId: alice.userId,
      });
      await insertWorkflowRun(job.id, { state: "completed" });
      await insertAgent(ws, "org-agent", null);
      await insertAgent(ws, "alice-agent", alice.userId);

      const names = (rows: Awaited<ReturnType<typeof listWork>>) => rows.map((r) => r.name).sort();
      expect(names(await listWork(bob))).toEqual(["org task", "org-agent"]);
      expect(names(await listWork(alice))).toEqual([
        "alice job",
        "alice job",
        "alice schedule",
        "alice task",
        "alice-agent",
        "org task",
        "org-agent",
      ]);
      const forAdmin = await listWork(admin);
      expect(names(forAdmin)).toEqual(names(await listWork(alice)));
      const privateRows = forAdmin.filter((r) => r.ownerUserId);
      expect(privateRows.length).toBe(5);
      expect(new Set(privateRows.map((r) => r.ownerName))).toEqual(new Set(["Alice"]));
      expect(forAdmin.find((r) => r.name === "org task")?.ownerUserId).toBeNull();
    });

    it("resolves someone else's private work to nothing for a member, and to a row for an admin", async () => {
      const task = await insertTask({
        workspaceId: ws,
        title: "alice task",
        ownerUserId: alice.userId,
      });
      expect(await resolveWork(task.id, bob)).toBeNull();
      expect((await resolveWork(task.id, alice))?.row.name).toBe("alice task");
      expect((await resolveWork(task.id, admin))?.row.ownerName).toBe("Alice");
    });

    it("over HTTP: acting on someone's private task is theirs alone; admins can't run it either", async () => {
      const task = await insertTask({
        workspaceId: ws,
        title: "alice task",
        ownerUserId: alice.userId,
        state: "failed",
      });
      const as = (actor: Actor, role: "admin" | "member") =>
        buildRouteTestApp(taskRoutes, {
          user: { id: actor.userId!, workspaceId: ws, workspaceRole: role },
        });
      const bobApp = await as(bob, "member");
      expect(
        (await bobApp.inject({ method: "GET", url: `/api/tasks/${task.id}` })).statusCode,
      ).toBe(404);
      expect(
        (await bobApp.inject({ method: "POST", url: `/api/tasks/${task.id}/cancel` })).statusCode,
      ).toBe(403);
      const adminApp = await as(admin, "admin");
      expect(
        (await adminApp.inject({ method: "GET", url: `/api/tasks/${task.id}` })).statusCode,
      ).toBe(200);
      const retry = await adminApp.inject({ method: "POST", url: `/api/tasks/${task.id}/retry` });
      expect(retry.statusCode).toBe(403);
      expect(retry.json().error).toMatch(/Only Alice can run this/);
      const list = await bobApp.inject({ method: "GET", url: "/api/tasks" });
      expect(list.json().tasks.map((t: { id: string }) => t.id)).not.toContain(task.id);
    });
  });

  describe("persistent agents", () => {
    it("lists the organization's and the viewer's own; a foreign private agent resolves to null", async () => {
      await insertAgent(ws, "org-agent", null);
      const mine = await insertAgent(ws, "alice-agent", alice.userId);
      expect((await listPersistentAgents(ws, bob)).map((a) => a.slug)).toEqual(["org-agent"]);
      expect((await listPersistentAgents(ws, alice)).map((a) => a.slug).sort()).toEqual([
        "alice-agent",
        "org-agent",
      ]);
      expect((await listPersistentAgents(ws, admin)).length).toBe(2);
      // Workers (no viewer) still see every agent.
      expect((await listPersistentAgents(ws)).length).toBe(2);
      expect(await getPersistentAgentScoped(mine.id, ws, bob)).toBeNull();
      expect((await getPersistentAgentScoped(mine.id, ws, admin))?.slug).toBe("alice-agent");
    });
  });

  describe("MCP servers, skills and prompts", () => {
    it("reach only their owner's work, and list by the same rule", async () => {
      await createMcpServer({ name: "org-mcp", command: "npx" }, ws);
      await createMcpServer({ name: "alice-mcp", command: "npx", ownerUserId: alice.userId }, ws);
      await createSkill({ name: "org-skill", prompt: "p" }, ws);
      await createSkill({ name: "alice-skill", prompt: "p", ownerUserId: alice.userId }, ws);

      const slugs = <T extends { name: string }>(rows: T[]) => rows.map((r) => r.name).sort();
      expect(slugs(await listMcpServers(undefined, ws, bob))).toEqual(["org-mcp"]);
      expect(slugs(await listMcpServers(undefined, ws, alice))).toEqual(["alice-mcp", "org-mcp"]);
      expect(slugs(await listMcpServers(undefined, ws, admin))).toEqual(["alice-mcp", "org-mcp"]);
      expect(slugs(await listSkills(undefined, ws, bob))).toEqual(["org-skill"]);

      // What a pod gets: the organization's for organization work, plus the owner's own.
      expect(slugs(await getMcpServersForTask("", ws, null))).toEqual(["org-mcp"]);
      expect(slugs(await getMcpServersForTask("", ws, alice.userId))).toEqual([
        "alice-mcp",
        "org-mcp",
      ]);
      expect(slugs(await getMcpServersForTask("", ws, bob.userId))).toEqual(["org-mcp"]);
      expect(slugs(await getSkillsForTask("", ws, "claude-code", alice.userId))).toEqual([
        "alice-skill",
        "org-skill",
      ]);
    });

    it("lets two people each have a private prompt of the same name, apart from the organization's", async () => {
      await createNamedTemplate({ name: "Daily digest", template: "org", workspaceId: ws });
      await createNamedTemplate({
        name: "Daily digest",
        template: "alice",
        workspaceId: ws,
        ownerUserId: alice.userId,
      });
      await createNamedTemplate({
        name: "Daily digest",
        template: "bob",
        workspaceId: ws,
        ownerUserId: bob.userId,
      });
      // …but not two of the same name in one scope.
      await expect(
        createNamedTemplate({ name: "Daily digest", template: "dup", workspaceId: ws }),
      ).rejects.toThrow();

      const bodies = (rows: { template: string }[]) => rows.map((r) => r.template).sort();
      expect(bodies(await listPromptTemplates({ workspaceId: ws, viewer: alice }))).toEqual([
        "alice",
        "org",
      ]);
      expect(bodies(await listPromptTemplates({ workspaceId: ws, viewer: admin }))).toEqual([
        "alice",
        "bob",
        "org",
      ]);
      // The organization's row is the one without an owner.
      const org = (await listPromptTemplates({ workspaceId: ws, viewer: bob })).find(
        (t) => t.template === "org",
      );
      expect(org?.ownerUserId).toBeNull();
    });
  });
});
