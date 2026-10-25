import { CLAUDE_MANAGED_SETTINGS_PATH } from "@optio/shared";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import { db } from "../db/client.js";
import {
  users,
  workspaceMembers,
  persistentAgents,
  persistentAgentTurns,
  workDefinitions,
  workRuns,
  taskMessages,
} from "../db/schema.js";
import {
  insertRepo,
  insertTask,
  insertWorkspace,
  insertWorkflow,
  insertWorkflowRun,
} from "../test-utils/integration/fixtures.js";
import { createControllerMcp } from "./controller-mcp.js";
import {
  authenticateController,
  issueControllerToken,
  validateControllerToken,
  type ControllerPrincipal,
} from "./controller-auth.js";
import * as controller from "./controller-service.js";
import { createApiKey, revokeApiKey } from "./api-key-service.js";
import { buildAgentEnvironment } from "./agent-environment-service.js";
import { insertLog } from "./run-log-service.js";
import { advanceScheduleCas } from "./trigger-service.js";
import { controllerMcpRoutes } from "../routes/controller-mcp.js";
import { logger } from "../logger.js";

// These tests run with the automatic-merge confirmation on (off by default).
vi.hoisted(() => {
  process.env.OPTIO_MERGE_CONFIRMATION = "true";
});

vi.mock("./reconcile-queue.js", () => ({ enqueueReconcile: vi.fn() }));
const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(closes.splice(0).map((close) => close()));
});

async function world() {
  const ws = await insertWorkspace();
  const other = await insertWorkspace();
  const [alice, bob] = await db
    .insert(users)
    .values(
      ["alice", "bob"].map((name) => ({
        provider: "github",
        externalId: randomUUID(),
        email: `${randomUUID()}@test.invalid`,
        displayName: name,
        defaultWorkspaceId: ws.id,
      })),
    )
    .returning();
  await db.insert(workspaceMembers).values(
    [alice, bob].map((user) => ({
      workspaceId: ws.id,
      userId: user.id,
      role: "member" as const,
    })),
  );
  const p: ControllerPrincipal = {
    actor: { userId: alice.id, workspaceId: ws.id, isAdmin: false },
    access: "manage",
    name: "Alice",
  };
  return { ws, other, alice, bob, p };
}
async function mcp(p: ControllerPrincipal) {
  const server = createControllerMcp(p);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  closes.push(
    () => client.close(),
    () => server.close(),
  );
  return client;
}
async function agent(workspaceId: string | null, ownerUserId: string | null = null, settings = {}) {
  const [row] = await db
    .insert(persistentAgents)
    .values({
      workspaceId,
      ownerUserId,
      slug: `agent-${randomUUID()}`,
      name: "Test agent",
      agentRuntime: "claude-code",
      initialPrompt: "Ready",
      settings,
    })
    .returning();
  return row;
}
const spec = (name = `Scheduled ${randomUUID()}`) => ({
  name,
  when: {
    type: "schedule" as const,
    config: { cronExpression: "0 9 * * *", timezone: "America/Denver" },
  },
  where: { runTarget: "cluster" as const },
  who: { runtime: "claude-code" },
  what: { prompt: "Summarize yesterday's results" },
  then: "exits" as const,
});

describe("controller MCP against Postgres and Redis", () => {
  it("discovers different runtimes and supports replies between tasks, Jobs and persistent agents", async () => {
    const { p, ws } = await world();
    const task = await insertTask({
      workspaceId: ws.id,
      state: "running",
      agentType: "codex",
      settings: { controllerAccess: "manage" },
    });
    const job = await insertWorkflow({
      workspaceId: ws.id,
      name: "Gemini researcher",
      agentType: "gemini",
      settings: { controllerAccess: "manage" },
    });
    const run = await insertWorkflowRun(job.id, { state: "running" });
    const persistent = await agent(ws.id);
    const caller = {
      ...p,
      name: "Codex implementer",
      run: { kind: "work-run" as const, id: task.id },
    };
    const recipient = {
      ...p,
      name: "Gemini researcher",
      run: { kind: "work-run" as const, id: run.id },
    };
    const directory = await controller.listControllerAgents(caller, { limit: 100, offset: 0 });
    expect(directory.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: task.id,
          agentRuntime: "codex",
          canMessage: false,
          delivery: "inbox",
        }),
        expect.objectContaining({
          id: run.id,
          name: job.name,
          agentRuntime: "gemini",
          canMessage: true,
          delivery: "inbox",
        }),
        expect.objectContaining({ id: persistent.id, delivery: "wake" }),
      ]),
    );
    expect(
      (
        await controller.listControllerAgents(caller, {
          limit: 10,
          offset: 0,
          kind: "job-run",
          runtime: "gemini",
          search: "researcher",
        })
      ).rows.map((r) => r.id),
    ).toEqual([run.id]);
    const first = await controller.listControllerAgents(caller, { limit: 1, offset: 0 });
    const next = await controller.listControllerAgents(caller, {
      limit: 1,
      offset: first.nextOffset!,
    });
    expect(first.rows[0].id).not.toBe(next.rows[0].id);
    const sent = await controller.sendControllerMessage(
      caller,
      run.id,
      "Please inspect the API contract",
    );
    expect(sent).toMatchObject({ status: "queued", delivery: "inbox" });
    const inbox = await controller.controllerInbox(recipient, undefined, 20, 0);
    expect(inbox.messages[0]).toMatchObject({
      body: "Please inspect the API contract",
      senderType: "agent",
      senderName: "Codex implementer",
      replyTo: task.id,
    });
    const [stored] = await db
      .select()
      .from(taskMessages)
      .where(eq(taskMessages.id, sent.messageId));
    expect(stored.userId).toBeNull();
    const client = await mcp(recipient);
    const reply = await client.callTool({
      name: "optio_send_message",
      arguments: { to: inbox.messages[0].replyTo, body: "Contract looks good" },
    });
    expect(reply.isError).not.toBe(true);
    expect((await controller.controllerInbox(caller, undefined, 20, 0)).messages[0]).toMatchObject({
      body: "Contract looks good",
      replyTo: run.id,
    });
    await controller.sendControllerMessage(caller, persistent.id, "Please summarize the results");
    const persistentInbox = await controller.controllerInbox(p, persistent.id, 20, 0);
    expect(persistentInbox.messages[0].replyTo).toBe(task.id);
    const persistentCaller = {
      ...p,
      name: "Coordinator",
      run: {
        kind: "turn" as const,
        id: randomUUID(),
        agentId: persistent.id,
        slug: persistent.slug,
      },
    };
    await controller.sendControllerMessage(persistentCaller, `work/${task.id}`, "Summary ready");
    expect((await controller.controllerInbox(caller, undefined, 20, 0)).messages[0]).toMatchObject({
      body: "Summary ready",
      replyTo: persistent.id,
    });
    await db
      .update(workRuns)
      .set({ state: "completed", execState: "exited" })
      .where(eq(workRuns.id, run.id));
    await expect(
      controller.sendControllerMessage(caller, run.id, "More work"),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await controller.listControllerAgents(p, { limit: 100, offset: 0 })).rows.map((r) => r.id),
    ).not.toContain(run.id);
    expect((await controller.controllerInbox(p, run.id, 20, 0)).messages).toHaveLength(1);
  });

  it("does not expose or accept messages for unavailable and inaccessible run recipients", async () => {
    const { p, ws, other, bob } = await world();
    const active = {
      state: "running" as const,
      settings: { controllerAccess: "manage" as const },
      workspaceId: ws.id,
    };
    const hidden = await Promise.all([
      insertTask({ ...active, workspaceId: other.id }),
      insertTask({ ...active, ownerUserId: bob.id }),
      insertTask({ ...active, workspaceId: null }),
    ]);
    closes.push(async () => db.delete(workRuns).where(eq(workRuns.id, hidden[2].id)));
    const unavailable = await Promise.all([
      insertTask({ ...active, settings: null }),
      insertTask({ ...active, state: "completed" }),
      insertTask({ ...active, runTarget: "local" }),
      insertTask({ ...active, execState: "exited" }),
      insertTask({ ...active, recoveryRequired: true }),
      insertTask({ ...active, controlIntent: "cancel" }),
      insertTask({ ...active, taskType: "review" }),
    ]);
    const shell = await insertWorkflow({
      workspaceId: ws.id,
      agentType: null,
      settings: { controllerAccess: "manage" },
    });
    const shellRun = await insertWorkflowRun(shell.id, { state: "running" });
    const mismatched = await insertWorkflow({
      workspaceId: other.id,
      settings: { controllerAccess: "manage" },
    });
    const mismatchRun = await insertWorkflowRun(mismatched.id, {
      state: "running",
      workspaceId: ws.id,
    });
    expect((await controller.listControllerAgents(p, { limit: 100, offset: 0 })).rows).toHaveLength(
      0,
    );
    for (const row of hidden) {
      await expect(controller.sendControllerMessage(p, row.id, "No")).rejects.toMatchObject({
        status: 404,
      });
      await expect(controller.controllerInbox(p, row.id, 10, 0)).rejects.toMatchObject({
        status: 404,
      });
    }
    for (const row of [...unavailable, shellRun, mismatchRun])
      await expect(controller.sendControllerMessage(p, row.id, "No")).rejects.toMatchObject({
        status: row.runTarget === "local" ? 403 : 409,
      });
    const admin = { ...p, actor: { ...p.actor, isAdmin: true } };
    await expect(controller.sendControllerMessage(admin, hidden[1].id, "No")).rejects.toMatchObject(
      { status: 403 },
    );
    const readable = await insertTask(active);
    const reader = { ...p, access: "read" as const };
    expect(
      (await controller.listControllerAgents(reader, { limit: 100, offset: 0 })).rows[0].canMessage,
    ).toBe(false);
    await expect(controller.sendControllerMessage(reader, readable.id, "No")).rejects.toMatchObject(
      { status: 403 },
    );
    const self = { ...p, run: { kind: "work-run" as const, id: readable.id } };
    await expect(controller.sendControllerMessage(self, readable.id, "No")).rejects.toMatchObject({
      status: 400,
    });
    const sent = await controller.sendControllerMessage(p, readable.id, "From Alice");
    expect((await controller.controllerInbox(p, readable.id, 10, 0)).messages[0]).toMatchObject({
      id: sent.messageId,
      senderType: "user",
      senderName: "Alice",
      replyTo: null,
    });
  });

  it("discovers tools, creates scheduled work atomically, edits its schedule and pauses it", async () => {
    const { p } = await world();
    const client = await mcp(p);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("optio_send_message");
    const result = await client.callTool({
      name: "optio_create_work",
      arguments: { spec: spec() },
    });
    expect(result.isError).not.toBe(true);
    const { id } = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    const { triggers } = await controller.listControllerTriggers(p, id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].config).toMatchObject({ timezone: "America/Denver" });
    expect(
      new Intl.DateTimeFormat("en", {
        timeZone: "America/Denver",
        hour: "numeric",
        hour12: false,
      }).format(triggers[0].nextFireAt!),
    ).toBe("09");
    await controller.setControllerSchedule(p, {
      id,
      triggerId: triggers[0].id,
      cron: "0 10 * * *",
      timezone: "Asia/Tokyo",
      enabled: true,
    });
    const [updated] = (await controller.listControllerTriggers(p, id)).triggers;
    expect(
      new Intl.DateTimeFormat("en", {
        timeZone: "Asia/Tokyo",
        hour: "numeric",
        hour12: false,
      }).format(updated.nextFireAt!),
    ).toBe("10");
    expect(
      await advanceScheduleCas(updated.id, "0 10 * * *", updated.nextFireAt, db, "Asia/Tokyo"),
    ).toBe(true);
    await controller.setControllerWorkEnabled(p, id, false);
    await expect(controller.runControllerWork(p, id)).rejects.toMatchObject({ status: 409 });
    await controller.deleteControllerSchedule(p, id, updated.id);
    expect((await controller.listControllerTriggers(p, id)).triggers).toHaveLength(0);
  });

  it("rejects an invalid schedule without leaving a definition behind", async () => {
    const { p } = await world();
    const bad = spec();
    bad.when.config.timezone = "Not/AZone";
    await expect(controller.createControllerWork(p, bad)).rejects.toThrow();
    expect(
      await db.select().from(workDefinitions).where(eq(workDefinitions.name, bad.name)),
    ).toHaveLength(0);
  });

  it("never turns on automatic merging through a tool, even when the call claims the confirmation", async () => {
    const { p } = await world();
    const merging = {
      ...spec(),
      where: {
        runTarget: "cluster" as const,
        repoUrl: `https://github.com/acme/merge-${randomUUID()}`,
        repoBranch: "main",
      },
      then: "until-merged" as const,
      mergeWhenReady: true,
      autoMergeConfirmed: true,
    };
    await expect(controller.createControllerWork(p, merging)).rejects.toMatchObject({
      status: 400,
      message: "Automatic merging needs the checkbox and the confirmation",
    });
    expect(
      await db.select().from(workDefinitions).where(eq(workDefinitions.name, merging.name)),
    ).toHaveLength(0);
  });

  it("keeps both null and named tenants exact, including private work and logs", async () => {
    const { p, ws, other, alice, bob } = await world();
    const own = await insertTask({ workspaceId: ws.id, ownerUserId: alice.id });
    const org = await insertTask({ workspaceId: ws.id });
    const privateTask = await insertTask({ workspaceId: ws.id, ownerUserId: bob.id });
    const foreign = await insertTask({ workspaceId: other.id });
    const legacy = await insertTask({ workspaceId: null });
    const list = await controller.listControllerWork(p, { limit: 100, offset: 0 });
    expect(list.rows.map((r) => r.id).sort()).toEqual([own.id, org.id].sort());
    for (const task of [privateTask, foreign, legacy]) {
      await expect(controller.getControllerWork(p, task.id)).rejects.toMatchObject({ status: 404 });
      await expect(
        controller.controllerLogs(p, task.id, { limit: 20, offset: 0 }),
      ).rejects.toMatchObject({ status: 404 });
    }
    await insertLog({ taskId: own.id }, { content: "result one" });
    await insertLog({ taskId: own.id }, { content: "result two" });
    const logs = await controller.controllerLogs(p, own.id, { limit: 1, offset: 0 });
    expect(logs.logs).toHaveLength(1);
    expect(logs.nextOffset).toBe(1);
    const local: ControllerPrincipal = {
      ...p,
      actor: { userId: null, workspaceId: null, isAdmin: false },
    };
    expect(
      (await controller.listControllerWork(local, { limit: 100, offset: 0 })).rows.map((r) => r.id),
    ).toEqual([legacy.id]);
  });

  it("list_repos scopes to the principal's workspace, and a principal without one sees every repo", async () => {
    const { ws, other, p } = await world();
    const mine = await insertRepo({ workspaceId: ws.id, fullName: "acme/mine" });
    await insertRepo({ workspaceId: other.id, fullName: "acme/theirs" });
    expect((await controller.listControllerRepos(p, 10, 0)).repos.map((r) => r.id)).toEqual([
      mine.id,
    ]);
    // Auth disabled: the Ask Optio session's principal has no workspace, yet
    // every repo row carries one — list them all, as GET /api/repos does.
    const local: ControllerPrincipal = {
      ...p,
      actor: { userId: null, workspaceId: null, isAdmin: false },
    };
    const names = (await controller.listControllerRepos(local, 10, 0)).repos.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["acme/mine", "acme/theirs"]));
  });

  it("read-only clients cannot discover or invoke writes, and tools return protocol errors cleanly", async () => {
    const { p } = await world();
    const client = await mcp({ ...p, access: "read" });
    expect((await client.listTools()).tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    const denied = await client.callTool({
      name: "optio_create_work",
      arguments: { spec: spec() },
    });
    expect(denied.isError).toBe(true);
    const missing = await client.callTool({
      name: "optio_get_work",
      arguments: { id: randomUUID() },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toContain("Work not found");
  });

  it("cannot start, enable or schedule work on a machine through controller tools", async () => {
    const { p, ws } = await world();
    const job = await insertWorkflow({ workspaceId: ws.id, runTarget: "local" });
    await expect(controller.runControllerWork(p, job.id)).rejects.toMatchObject({ status: 403 });
    await expect(controller.setControllerWorkEnabled(p, job.id, true)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      controller.setControllerSchedule(p, {
        id: job.id,
        cron: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("attributes messages to the calling agent, preserves inboxes, and rejects self/private/foreign recipients", async () => {
    const { p, ws, other, bob } = await world();
    const sender = await agent(ws.id, p.actor.userId);
    const receiver = await agent(ws.id);
    const privatePeer = await agent(ws.id, bob.id);
    const foreign = await agent(other.id);
    const principal = {
      ...p,
      run: { kind: "turn" as const, id: randomUUID(), agentId: sender.id, slug: sender.slug },
    };
    const receipt = await controller.sendControllerMessage(
      principal,
      receiver.slug,
      "Please review today's results",
    );
    expect(receipt.status).toBe("queued");
    const inbox = await controller.controllerInbox(p, receiver.id, 20, 0);
    expect(inbox.messages[0]).toMatchObject({
      id: receipt.messageId,
      senderType: "agent",
      senderId: `agent:${ws.id}/${sender.slug}`,
      processedAt: null,
    });
    await expect(
      controller.sendControllerMessage(principal, sender.id, "self"),
    ).rejects.toMatchObject({ status: 400 });
    for (const target of [privatePeer, foreign])
      await expect(
        controller.sendControllerMessage(principal, target.id, "no"),
      ).rejects.toMatchObject({ status: 404 });
    const admin = { ...p, actor: { ...p.actor, isAdmin: true } };
    await expect(
      controller.sendControllerMessage(admin, privatePeer.id, "no"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("run credentials rotate, expire, cannot switch workspaces and stop working on completion or revocation", async () => {
    const { ws, other, alice } = await world();
    const row = await insertTask({
      workspaceId: ws.id,
      ownerUserId: alice.id,
      state: "running",
      settings: { controllerAccess: "manage" },
    });
    const grant = {
      kind: "work-run" as const,
      id: row.id,
      workspaceId: ws.id,
      ownerUserId: alice.id,
      access: "manage" as const,
    };
    const old = await issueControllerToken(grant);
    const token = await issueControllerToken(grant);
    expect(await validateControllerToken(old)).toBeNull();
    expect(await validateControllerToken(token)).toMatchObject({
      access: "manage",
      actor: { isAdmin: false },
    });
    expect(await authenticateController(`Bearer ${token}`, other.id)).toBeNull();
    expect(await validateControllerToken(token.slice(0, -4) + "xxxx")).toBeNull();
    await db
      .update(workRuns)
      .set({ settings: { controllerAccess: "read" } })
      .where(eq(workRuns.id, row.id));
    expect(await validateControllerToken(token)).toBeNull();
    await db
      .update(workRuns)
      .set({ settings: { controllerAccess: "manage" }, state: "completed" })
      .where(eq(workRuns.id, row.id));
    expect(await validateControllerToken(token)).toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 25 * 3600_000);
    expect(await validateControllerToken(token)).toBeNull();
  });

  it("messaging credentials only authenticate active turns, never public UUIDs or the MCP", async () => {
    const { ws } = await world();
    const a = await agent(ws.id);
    await db
      .update(persistentAgents)
      .set({ state: "running" })
      .where(eq(persistentAgents.id, a.id));
    const [turn] = await db
      .insert(persistentAgentTurns)
      .values({ agentId: a.id, turnNumber: 1, wakeSource: "user" })
      .returning();
    const token = await issueControllerToken({
      kind: "turn",
      id: turn.id,
      workspaceId: ws.id,
      ownerUserId: null,
      access: "messages",
    });
    expect(await validateControllerToken(token, "messages")).toMatchObject({
      run: { agentId: a.id },
    });
    expect(await validateControllerToken(token)).toBeNull();
    expect(await validateControllerToken(a.id, "messages")).toBeNull();
    await db
      .update(persistentAgentTurns)
      .set({ finishedAt: new Date() })
      .where(eq(persistentAgentTurns.id, turn.id));
    expect(await validateControllerToken(token, "messages")).toBeNull();
  });

  it("delegated creation inherits ownership, defaults to no controller, and permits explicit delegation", async () => {
    const { p } = await world();
    const principal = { ...p, run: { kind: "work-run" as const, id: randomUUID() } };
    const created = await controller.createControllerWork(principal, {
      ...spec(),
      owner: "workspace",
    });
    const found = await controller.getControllerWork(p, created.id);
    expect(found.data).toMatchObject({ ownerUserId: p.actor.userId, settings: null });
    const delegated = await controller.createControllerWork(principal, {
      ...spec(),
      settings: { controllerAccess: "read" },
    });
    expect((await controller.getControllerWork(p, delegated.id)).data).toMatchObject({
      ownerUserId: p.actor.userId,
      settings: { controllerAccess: "read" },
    });
  });

  it("injects protected controller config for every agent harness, omitting commands and untrusted reviews", async () => {
    const { ws } = await world();
    const job = await insertWorkflow({
      workspaceId: ws.id,
      settings: { controllerAccess: "read" },
    });
    for (const agentType of ["claude-code", "codex", "gemini", "opencode", "copilot", "cursor"]) {
      const env = await buildAgentEnvironment(
        {
          repoUrl: null,
          agentType,
          workspaceId: ws.id,
          ownerUserId: null,
          runId: randomUUID(),
          controllerRunKind: "work-run",
          settings: job.settings,
        },
        logger,
      );
      const files = JSON.parse(Buffer.from(env.OPTIO_SETUP_FILES, "base64").toString()) as Array<{
        path: string;
        sensitive?: boolean;
        content: string;
      }>;
      const mcpFile = files.find((f) => f.path === ".mcp.json")!;
      expect(mcpFile.sensitive).toBe(true);
      expect(JSON.parse(mcpFile.content).mcpServers["optio-controller"].args).toEqual([
        "/opt/optio/controller-mcp.js",
      ]);
    }
    for (const extra of [
      { agentType: null },
      { agentType: "claude-code", connectionSecrets: false },
    ]) {
      const env = await buildAgentEnvironment(
        {
          repoUrl: null,
          workspaceId: ws.id,
          ownerUserId: null,
          runId: randomUUID(),
          controllerRunKind: "work-run",
          settings: job.settings,
          ...extra,
        },
        logger,
      );
      expect(JSON.stringify(env)).not.toContain("optio_run_");
      // A Claude Code run, an untrusted review too, also gets the agent
      // policy's deny rules (services/agent-policy.ts) — never the controller's config.
      const setupFiles = env.OPTIO_SETUP_FILES
        ? (JSON.parse(Buffer.from(env.OPTIO_SETUP_FILES, "base64").toString()) as Array<{
            path: string;
          }>)
        : [];
      expect(setupFiles.filter((f) => f.path !== CLAUDE_MANAGED_SETTINGS_PATH)).toEqual([]);
      expect(JSON.stringify(setupFiles)).not.toContain("optio-controller");
    }
  });

  it("HTTP MCP authenticates each request with PAT roles and rejects browser origins and malformed tokens", async () => {
    const { p, alice, ws, other } = await world();
    const pat = await createApiKey(alice.id, "controller test");
    const app = Fastify();
    await app.register(controllerMcpRoutes);
    closes.push(() => app.close());
    const payload = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const headers = {
      authorization: `Bearer ${pat.token}`,
      accept: "application/json, text/event-stream",
    };
    vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
    const listed = await app.inject({ method: "POST", url: "/api/mcp", headers, payload });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().result.tools.length).toBeGreaterThan(10);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/mcp",
          headers: { ...headers, origin: "https://evil.example" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/mcp",
          headers: { ...headers, "x-workspace-id": other.id },
          payload,
        })
      ).statusCode,
    ).toBe(401);
    await db
      .update(workspaceMembers)
      .set({ role: "viewer" })
      .where(eq(workspaceMembers.userId, alice.id));
    expect(await authenticateController(headers.authorization)).toMatchObject({
      access: "read",
      actor: { workspaceId: ws.id },
    });
    const read = await app.inject({ method: "POST", url: "/api/mcp", headers, payload });
    expect(
      read
        .json()
        .result.tools.every(
          (t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint,
        ),
    ).toBe(true);
    await revokeApiKey(pat.tokenId, alice.id);
    expect(
      (await app.inject({ method: "POST", url: "/api/mcp", headers, payload })).statusCode,
    ).toBe(401);
    vi.stubEnv("OPTIO_AUTH_DISABLED", "true");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/mcp",
          headers: { ...headers, authorization: "Bearer forged" },
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/mcp",
          headers: { host: "evil.example" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(p.actor.userId).toBe(alice.id);
  });
});
