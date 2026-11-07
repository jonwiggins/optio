import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";
import { issueControllerToken } from "../src/services/controller-auth.js";

let api: ApiServerHandle;
let client: Client;
beforeAll(async () => {
  api = await startApiServer();
  client = new Client({ name: "controller-e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${api.baseUrl}/api/mcp`)));
  const seeded = await fetch(`${api.baseUrl}/api/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ANTHROPIC_API_KEY", value: "test-only-fake-key" }),
  });
  expect(seeded.ok).toBe(true);
}, 150_000);
afterAll(async () => {
  await client?.close();
  await api?.stop();
});

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name: `optio_${name}`, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse((result.content as Array<{ text: string }>)[0].text) as T;
}

describe("controller MCP pipeline", () => {
  it("gives active Job runs discoverable addresses and inboxes under their own credentials", async () => {
    const jobs = await Promise.all(
      ["sender", "receiver"].map((name) =>
        call<{ id: string; run: { id: string } }>("create_work", {
          spec: {
            name: `MCP run ${name}`,
            when: { type: "manual" },
            where: { runTarget: "cluster" },
            who: { runtime: "claude-code" },
            // Keep both real-worker runs active through MCP connection setup and messaging.
            what: { prompt: "Continue working [[mock:sleep:20000]]" },
            then: "exits",
            maxRetries: 0,
            settings: { controllerAccess: "manage" },
          },
        }),
      ),
    );
    const clients: Client[] = [];
    try {
      for (const job of jobs) {
        await waitFor(
          async () => {
            const work = await call<{ state: string }>("get_work", { id: job.run.id });
            return work.state === "running" ? work : null;
          },
          { timeoutMs: 90000, label: "run is active" },
        );
        // The fake agent cannot execute MCP calls. Give its test-side client a
        // fresh run credential while the real worker owns an active execution.
        const token = await issueControllerToken({
          kind: "work-run",
          id: job.run.id,
          workspaceId: null,
          ownerUserId: null,
          access: "manage",
        });
        const scoped = new Client({ name: "run-collaboration-test", version: "1" });
        await scoped.connect(
          new StreamableHTTPClientTransport(new URL(`${api.baseUrl}/api/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }),
        );
        clients.push(scoped);
      }
      async function scopedCall(index: number, name: string, args: Record<string, unknown> = {}) {
        const r = await clients[index].callTool({ name: `optio_${name}`, arguments: args });
        expect(r.isError, JSON.stringify(r)).not.toBe(true);
        return JSON.parse((r.content as Array<{ text: string }>)[0].text);
      }
      const directory = await scopedCall(0, "list_agents", { kind: "job-run" });
      expect(directory.rows).toContainEqual(
        expect.objectContaining({ address: jobs[1].run.id, delivery: "inbox", canMessage: true }),
      );
      const message = await scopedCall(0, "send_message", {
        to: jobs[1].run.id,
        body: "Please check the output",
      });
      const received = await scopedCall(1, "read_inbox");
      expect(received.messages[0]).toMatchObject({
        id: message.messageId,
        body: "Please check the output",
        senderName: "MCP run sender",
        replyTo: jobs[0].run.id,
      });
      await scopedCall(1, "send_message", { to: received.messages[0].replyTo, body: "Checked" });
      expect((await scopedCall(0, "read_inbox")).messages[0]).toMatchObject({
        body: "Checked",
        replyTo: jobs[1].run.id,
      });
      for (const job of jobs)
        await waitFor(
          async () => {
            const result = await call<{ state: string }>("get_work", { id: job.run.id });
            return result.state === "completed" ? result : null;
          },
          { timeoutMs: 90000, label: "messaged run completes normally" },
        );
      const late = await client.callTool({
        name: "optio_send_message",
        arguments: { to: jobs[1].run.id, body: "Too late" },
      });
      expect(late.isError).toBe(true);
      expect(
        (await call<{ messages: unknown[] }>("read_inbox", { agent: jobs[1].run.id })).messages,
      ).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  }, 150000);

  it("schedules work over MCP, runs it, and reads its results and injected configuration", async () => {
    const created = await call<{ id: string }>("create_work", {
      spec: {
        name: "MCP scheduled job",
        when: {
          type: "schedule",
          config: { cronExpression: "0 9 * * *", timezone: "America/Denver" },
        },
        where: { runTarget: "cluster" },
        who: { runtime: "claude-code" },
        what: { prompt: "Controller test [[mock:file:.mcp.json]] [[mock:cost:0.023]]" },
        then: "exits",
        settings: { controllerAccess: "read" },
      },
    });
    const trigger = await call<{
      triggers: Array<{ nextFireAt: string; config: { timezone: string } }>;
    }>("list_triggers", { id: created.id });
    expect(trigger.triggers[0].config.timezone).toBe("America/Denver");
    expect(new Date(trigger.triggers[0].nextFireAt).getTime()).toBeGreaterThan(Date.now());
    const start = await call<{ runId: string }>("run_work", { id: created.id });
    const settled = await waitFor(
      async () => {
        const work = await call<{ state: string; costUsd: string }>("get_work", {
          id: start.runId,
        });
        return ["completed", "failed"].includes(work.state) ? work : null;
      },
      { timeoutMs: 90_000, label: "MCP job completes" },
    );
    expect(settled.state).toBe("completed");
    expect(Number(settled.costUsd)).toBeCloseTo(0.023);
    const runs = await call<{ runs: Array<{ id: string }> }>("list_runs", { id: created.id });
    expect(runs.runs.map((r) => r.id)).toContain(start.runId);
    const logs = await call<{ logs: Array<{ content: string }> }>("get_run_logs", {
      id: start.runId,
    });
    const line = logs.logs.find((l) => l.content.startsWith("file .mcp.json="));
    expect(line).toBeDefined();
    const config = JSON.parse(JSON.parse(line!.content.slice("file .mcp.json=".length)));
    const controller = config.mcpServers["optio-controller"];
    expect(controller.command).toBe("node");
    expect(controller.args).toEqual(["/opt/optio/controller-mcp.js"]);
    // A real credential was issued by the worker, but completion revoked it.
    const ended = await fetch(`${api.baseUrl}/api/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${controller.env.OPTIO_MCP_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    expect(ended.status).toBe(401);
    await call("set_work_enabled", { id: created.id, enabled: false });
  }, 110_000);

  it("creates persistent agents, sends a message and reads the recipient's resulting turn", async () => {
    const created = await call<{ id: string }>("create_work", {
      spec: {
        name: "MCP recipient",
        when: { type: "manual" },
        where: { runTarget: "cluster" },
        who: { runtime: "claude-code" },
        what: { prompt: "Wait for requests" },
        then: "waits-for-messages",
        agent: { slug: "mcp-recipient", podLifecycle: "on-demand" },
        settings: { controllerAccess: "manage" },
      },
    });
    const receipt = await call<{ messageId: string; status: string }>("send_message", {
      to: "mcp-recipient",
      body: "Review the latest scheduled work results",
    });
    expect(receipt.status).toBe("queued");
    const inbox = await call<{ messages: Array<{ id: string; body: string }> }>("read_inbox", {
      agent: created.id,
    });
    expect(inbox.messages).toContainEqual(
      expect.objectContaining({
        id: receipt.messageId,
        body: "Review the latest scheduled work results",
      }),
    );
    const turns = await waitFor(
      async () => {
        const result = await call<{
          runs: Array<{ id: string; finishedAt: string | null; state: string }>;
        }>("list_runs", { id: created.id });
        return result.runs.some((r) => r.finishedAt) ? result.runs : null;
      },
      { timeoutMs: 90_000, label: "MCP recipient responds" },
    );
    expect(turns[0].state).not.toBe("error");
    const logs = await call<{ logs: unknown[] }>("get_run_logs", { id: turns[0].id });
    expect(logs.logs.length).toBeGreaterThan(0);
  }, 110_000);
});
