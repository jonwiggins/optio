/**
 * E2E: Connections v2 through the real API server and a fake pod.
 *
 * A Pylon connection (a token on the REST bridge) and an AWS connection
 * (keys exported into the agent's shell) are created over HTTP, a Job is
 * connected to them, and the fake runtime prints what the pod would get:
 * the `.mcp.json` the exec script writes and the shell env it exports. The
 * API never returns the token; the pod gets it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;

beforeAll(async () => {
  server = await startApiServer();
}, 150_000);

afterAll(async () => {
  await server?.stop();
});

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface RunBody {
  run: { id: string; state: string; errorMessage: string | null };
}

interface ConnectionBody {
  connection: {
    id: string;
    config: Record<string, unknown>;
    secretFields: string[];
    parts: string[];
    provider: { slug: string } | null;
  };
}

async function logEntries(runId: string): Promise<string[]> {
  const { body } = await api<{ logs: Array<{ content: string }> }>(
    `/api/workflow-runs/${runId}/logs`,
  );
  return body.logs.map((l) => l.content);
}

async function logsOf(runId: string): Promise<string> {
  return (await logEntries(runId)).join("\n");
}

async function settled(runId: string): Promise<RunBody["run"]> {
  return waitFor(
    async () => {
      const { body } = await api<RunBody>(`/api/workflow-runs/${runId}`);
      return ["completed", "failed"].includes(body.run.state) ? body.run : null;
    },
    { timeoutMs: 90_000, label: `run ${runId} settles` },
  );
}

describe("connections e2e", () => {
  it("a Pylon connection reaches a Job's pod as the REST bridge, token only in the pod", async () => {
    const created = await api<ConnectionBody>("/api/connections", {
      method: "POST",
      body: JSON.stringify({
        name: "Support Pylon",
        providerSlug: "pylon",
        config: { PYLON_API_TOKEN: "pyl_e2e_token", PYLON_API_HOST: "api.eu.usepylon.com" },
        // On by default for every repo and every agent, so a Job gets it.
        assignments: [{ repoId: null }],
      }),
    });
    expect(created.status).toBe(201);
    const conn = created.body.connection;
    // The token is sealed: named, never returned.
    expect(conn.secretFields).toEqual(["PYLON_API_TOKEN"]);
    expect(conn.config).toEqual({ PYLON_API_HOST: "api.eu.usepylon.com" });
    expect(JSON.stringify(created.body)).not.toContain("pyl_e2e_token");
    expect(conn.parts).toEqual(["credentials", "tools", "note"]);

    const list = await api<{ connections: Array<{ id: string }> }>("/api/connections");
    expect(JSON.stringify(list.body)).not.toContain("pyl_e2e_token");

    const catalog = await api<{ entries: Array<{ kind: string; id: string; parts: string[] }> }>(
      "/api/connections/catalog",
    );
    const entry = catalog.body.entries.find((e) => e.kind === "connection" && e.id === conn.id);
    expect(entry?.parts).toEqual(["credentials", "tools", "note"]);

    const job = await api<{ workflow: { id: string } }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "pylon job",
        promptTemplate: "Look at the queue [[mock:file:.mcp.json]]",
        agentRuntime: "claude-code",
      }),
    });
    expect(job.status).toBe(201);
    const started = await api<RunBody>(`/api/jobs/${job.body.workflow.id}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const run = await settled(started.body.run.id);
    expect(run.state).toBe("completed");

    // The fake prints the file as a JSON string literal on one line.
    const line = (await logEntries(run.id)).find((l) => l.startsWith("file .mcp.json="));
    expect(line).toBeDefined();
    const text = JSON.parse(line!.slice("file .mcp.json=".length)) as string;
    const mcp = JSON.parse(text) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const pylon = mcp.mcpServers["Support Pylon"];
    expect(pylon.command).toBe("node");
    expect(pylon.args).toEqual(["/opt/optio/mcp-bridge.js"]);
    expect(pylon.env.OPTIO_HTTP_BASE_URL).toBe("https://api.eu.usepylon.com");
    expect(pylon.env.OPTIO_HTTP_AUTH_VALUE).toBe("Bearer pyl_e2e_token");
    expect(pylon.env.OPTIO_HTTP_NAME).toBe("Support Pylon");
  });

  it("an AWS connection exports its keys into the agent's shell", async () => {
    const created = await api<ConnectionBody>("/api/connections", {
      method: "POST",
      body: JSON.stringify({
        name: "Acme AWS",
        providerSlug: "aws",
        config: {
          AWS_ACCESS_KEY_ID: "AKIAE2E",
          AWS_SECRET_ACCESS_KEY: "e2e-secret",
          AWS_REGION: "eu-west-1",
        },
        assignments: [{ repoId: null }],
      }),
    });
    expect(created.status).toBe(201);
    const conn = created.body.connection;
    expect(conn.parts).toEqual(["credentials", "env", "note"]);

    const job = await api<{ workflow: { id: string } }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "aws job",
        promptTemplate:
          "List buckets [[mock:env:AWS_REGION]] [[mock:env:AWS_ACCESS_KEY_ID]] [[mock:file:.claude/skills/connection-acme-aws/SKILL.md]]",
        agentRuntime: "claude-code",
      }),
    });
    const started = await api<RunBody>(`/api/jobs/${job.body.workflow.id}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const run = await settled(started.body.run.id);
    expect(run.state).toBe("completed");
    const logs = await logsOf(run.id);
    expect(logs).toContain("env AWS_REGION=eu-west-1");
    expect(logs).toContain("env AWS_ACCESS_KEY_ID=AKIAE2E");
    const note = (await logEntries(run.id)).find((l) =>
      l.startsWith("file .claude/skills/connection-acme-aws/SKILL.md="),
    );
    expect(note).toBeDefined();
    const noteText = JSON.parse(note!.slice(note!.indexOf("=") + 1)) as string;
    expect(noteText).toMatch(/^---\nname: connection-acme-aws\n/);
    expect(noteText).toContain("aws sts get-caller-identity");

    // Switched off, the keys stay out of the shell.
    const patched = await api<ConnectionBody>(`/api/connections/${conn.id}`, {
      method: "PATCH",
      body: JSON.stringify({ exportShellEnv: false }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.connection.parts).toEqual(["credentials", "note"]);
    const again = await api<RunBody>(`/api/jobs/${job.body.workflow.id}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const run2 = await settled(again.body.run.id);
    expect(await logsOf(run2.id)).toContain("env AWS_REGION=<unset>");
  });
});
