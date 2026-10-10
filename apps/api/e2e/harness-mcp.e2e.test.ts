/**
 * E2E: an agent runtime other than Claude Code gets the work's MCP servers in
 * the file it reads, through the real API server and a fake pod.
 *
 * Cursor is the one such runtime the fake runtime can play (its stream-json
 * is claude-shaped), so a Cursor Job connected to a Pylon connection proves
 * the pipeline end to end: the exec script writes `.cursor/mcp.json` with
 * the REST bridge and the token, launches `cursor-agent --approve-mcps`, and
 * carries the line that removes a run's own home when it exits. The other
 * runtimes' files are covered against the real service in
 * `agent-environment-service.int.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;

beforeAll(async () => {
  server = await startApiServer();
  const res = await fetch(`${server.baseUrl}/api/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "CURSOR_API_KEY", value: "key_e2e_dummy" }),
  });
  expect([200, 201]).toContain(res.status);
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

async function logEntries(runId: string): Promise<string[]> {
  const { body } = await api<{ logs: Array<{ content: string }> }>(
    `/api/workflow-runs/${runId}/logs`,
  );
  return body.logs.map((l) => l.content);
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

const CLEANUP = "in /home/agent/optio/runs/*) rm -rf";

describe("harness MCP config e2e", () => {
  it("a Cursor Job gets its connection in .cursor/mcp.json and runs with the servers approved", async () => {
    const created = await api<{ connection: { id: string } }>("/api/connections", {
      method: "POST",
      body: JSON.stringify({
        name: "Support Pylon",
        providerSlug: "pylon",
        config: { PYLON_API_TOKEN: "pyl_e2e_token", PYLON_API_HOST: "api.eu.usepylon.com" },
        assignments: [{ repoId: null }],
      }),
    });
    expect(created.status).toBe(201);

    const job = await api<{ workflow: { id: string } }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "e2e cursor mcp job",
        promptTemplate:
          "Look at the queue [[mock:file:.cursor/mcp.json]] [[mock:file:.mcp.json]] " +
          `[[mock:env:OPTIO_RUN_HOME]] [[mock:script:--approve-mcps]] [[mock:script:${CLEANUP}]]`,
        agentRuntime: "cursor",
      }),
    });
    expect(job.status).toBe(201);
    const { body: started } = await api<RunBody>(`/api/jobs/${job.body.workflow.id}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const run = await settled(started.run.id);
    expect(run.state).toBe("completed");

    const lines = await logEntries(run.id);
    const fileLine = (path: string) => {
      const line = lines.find((l) => l.startsWith(`file ${path}=`));
      expect(line, `file ${path}`).toBeDefined();
      return JSON.parse(line!.slice(`file ${path}=`.length)) as string;
    };
    // Cursor's project file: the connection as the REST bridge, token in the pod only.
    const cursor = JSON.parse(fileLine(".cursor/mcp.json")) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const pylon = cursor.mcpServers["Support Pylon"];
    expect(pylon.command).toBe("node");
    expect(pylon.args).toEqual(["/opt/optio/mcp-bridge.js"]);
    expect(pylon.env.OPTIO_HTTP_AUTH_VALUE).toBe("Bearer pyl_e2e_token");
    // Claude Code's file is still written alongside.
    expect(JSON.parse(fileLine(".mcp.json")).mcpServers["Support Pylon"]).toBeDefined();
    // Cursor's file lives in the working directory: no home of the run's own.
    expect(lines).toContain("env OPTIO_RUN_HOME=<unset>");
    // The launch approves the servers, and the script removes a run home on exit.
    expect(lines).toContain("script --approve-mcps=present");
    expect(lines).toContain(`script ${CLEANUP}=present`);
  });
});
