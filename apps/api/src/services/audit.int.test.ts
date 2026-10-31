/**
 * Writing the audit trail (docs/audit.md) against real Postgres: an entry
 * keeps its client address beside the allowlisted details and drops anything
 * else; a sign-in lands in the workspace the person lands in; an automatic
 * merge names the confirmation it relied on (the run's own, else its
 * repo's); and the SIEM copy names the actor by email.
 */
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { db } from "../db/client.js";
import { optioActions, users, workspaceMembers } from "../db/schema.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";
import { auditAutoMerge, auditEvent, auditSignIn } from "./audit.js";
import { emitAuditLine, setAuditStdoutWriterForTests } from "./audit-stdout.js";
import { getRedisClient } from "./event-bus.js";

const uniq = () => randomBytes(4).toString("hex");

async function person(name: string, over: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "ldap",
      externalId: uniq(),
      email: `${name}-${uniq()}@example.test`,
      displayName: name,
      ...over,
    })
    .returning();
  return row;
}

const lastOf = async (action: string) =>
  (
    await db
      .select()
      .from(optioActions)
      .where(eq(optioActions.action, action))
      .orderBy(desc(optioActions.createdAt))
      .limit(1)
  )[0];

const reqOf = (user: { id: string; workspaceId: string | null } | null, ip = "10.9.8.7") =>
  ({ ip, user: user ?? undefined }) as unknown as FastifyRequest;

afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await getRedisClient().quit();
});

describe("auditEvent (integration)", () => {
  it("stores the client address in its own column and only allowlisted details", async () => {
    const ws = await insertWorkspace();
    const alice = await person("alice");
    await auditEvent({
      req: reqOf({ id: alice.id, workspaceId: ws.id }),
      action: "team.join.approve",
      details: { teamId: "t-1", targetUserId: "u-2", token: "must-not-be-stored", password: "x" },
    });
    const row = await lastOf("team.join.approve");
    expect(row).toMatchObject({
      workspaceId: ws.id,
      userId: alice.id,
      clientIp: "10.9.8.7",
      success: true,
      params: { teamId: "t-1", targetUserId: "u-2" },
    });
    expect(row.params).not.toHaveProperty("token");
    expect(row.params).not.toHaveProperty("password");
  });
});

describe("auditSignIn (integration)", () => {
  it("records the sign-in in the person's default workspace", async () => {
    const ws = await insertWorkspace();
    const carol = await person("carol", { defaultWorkspaceId: ws.id });
    await auditSignIn(reqOf(null), { provider: "ldap", userId: carol.id, via: "cli" });
    const row = await lastOf("auth.sign_in");
    expect(row).toMatchObject({
      userId: carol.id,
      workspaceId: ws.id,
      clientIp: "10.9.8.7",
      params: { provider: "ldap", via: "cli" },
    });
  });

  it("falls back to the first workspace they joined", async () => {
    const first = await insertWorkspace();
    const dave = await person("dave");
    await db.insert(workspaceMembers).values({ workspaceId: first.id, userId: dave.id });
    await auditSignIn(reqOf(null), { provider: "oidc", userId: dave.id, via: "web" });
    expect((await lastOf("auth.sign_in")).workspaceId).toBe(first.id);
  });
});

describe("auditAutoMerge (integration)", () => {
  it("records an automatic merge in the run's workspace", async () => {
    const ws = await insertWorkspace();
    const task = await insertTask({
      workspaceId: ws.id,
      autoMerge: true,
    });
    await auditAutoMerge({
      taskId: task.id,
      prUrl: "https://gitlab.example.test/p/r/-/merge_requests/7",
      prNumber: 7,
    });
    const row = await lastOf("pr.merge");
    expect(row).toMatchObject({
      userId: null,
      workspaceId: ws.id,
      clientIp: null,
      params: {
        via: "auto",
        taskId: task.id,
        prNumber: 7,
      },
    });
  });
});

describe("the SIEM copy (integration)", () => {
  it("prints each entry the action log writes, with the actor's email", async () => {
    vi.stubEnv("OPTIO_AUDIT_STDOUT", "json");
    const lines: string[] = [];
    const restore = setAuditStdoutWriterForTests((l) => lines.push(l));
    try {
      const ws = await insertWorkspace();
      const erin = await person("erin");
      await auditEvent({
        req: reqOf({ id: erin.id, workspaceId: ws.id }),
        action: "api_key.create",
        details: { id: "k-1", via: "settings" },
      });
      // logAction doesn't wait for the line; print the stored row again and wait.
      await emitAuditLine(await lastOf("api_key.create"));
      const line = lines.map((l) => JSON.parse(l)).find((l) => l.action === "api_key.create");
      expect(line).toMatchObject({
        type: "optio.audit",
        workspaceId: ws.id,
        actor: { id: erin.id, email: erin.email, name: "erin" },
        clientIp: "10.9.8.7",
        details: { id: "k-1", via: "settings" },
      });
    } finally {
      setAuditStdoutWriterForTests(restore);
    }
  });
});
