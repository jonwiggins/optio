/**
 * E2E: a Job that runs through a model provider (Amazon Bedrock) with picked
 * pod secrets, through the real API server and workflow worker.
 *
 * Covers: POST /api/model-providers (credentials stored, never returned) →
 * POST /api/jobs with `agentOptions.modelProvider` + `podSecrets` → the run's
 * agent gets CLAUDE_CODE_USE_BEDROCK, the region and the Bedrock API key, and
 * exactly the picked secret (the fake runtime echoes env via
 * [[mock:env:NAME]]). Also: a machines-only provider is refused for pod work.
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
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

interface Provider {
  id: string;
  hasPodCredentials: boolean;
}

describe("model providers e2e", () => {
  it("runs a Job on Bedrock with only the secrets it picked", async () => {
    const created = await api<{ provider: Provider } & Record<string, unknown>>(
      "/api/model-providers",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Bedrock e2e",
          owner: "workspace",
          kind: "bedrock",
          agents: ["claude-code", "codex"],
          region: "us-east-2",
          podCredential: "bearer-token",
          credentials: { type: "bearer-token", bearerToken: "bedrock-key-e2e" },
        }),
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.provider.hasPodCredentials).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain("bedrock-key-e2e");

    for (const [name, value] of [
      ["E2E_PICKED", "picked-value"],
      ["E2E_NOT_PICKED", "other-value"],
    ]) {
      const s = await api("/api/secrets", {
        method: "POST",
        body: JSON.stringify({ name, value }),
      });
      expect(s.status).toBe(201);
    }
    const pickable = await api<{ secrets: Array<{ name: string; owner: string }> }>(
      "/api/secrets/pickable",
    );
    expect(pickable.body.secrets).toContainEqual({ name: "E2E_PICKED", owner: "workspace" });

    const env = ["CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK"]
      .concat(["E2E_PICKED", "E2E_NOT_PICKED"])
      .map((n) => `[[mock:env:${n}]]`)
      .join(" ");
    const job = await api<{ workflow: { id: string; podSecrets: string[] | null } }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "e2e bedrock job",
        promptTemplate: `Say hi ${env}`,
        agentRuntime: "claude-code",
        maxRetries: 0,
        agentOptions: {
          modelProvider: created.body.provider.id,
          claudeModel: "us.anthropic.claude-sonnet-5",
        },
        podSecrets: ["E2E_PICKED"],
      }),
    });
    expect(job.status).toBe(201);
    expect(job.body.workflow.podSecrets).toEqual(["E2E_PICKED"]);

    const run = await api<{ run: { id: string } }>(`/api/jobs/${job.body.workflow.id}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(run.status).toBe(201);
    const runId = run.body.run.id;
    const final = await waitFor(
      async () => {
        const { body } = await api<{ run: { state: string } }>(`/api/workflow-runs/${runId}`);
        return ["completed", "failed"].includes(body.run.state) ? body.run : null;
      },
      { timeoutMs: 90_000, label: `bedrock run ${runId}` },
    );
    expect(final.state).toBe("completed");

    const { body: logs } = await api<{ logs: Array<{ content: string }> }>(
      `/api/workflow-runs/${runId}/logs`,
    );
    const text = logs.logs.map((l) => l.content).join("\n");
    expect(text).toContain("env CLAUDE_CODE_USE_BEDROCK=1");
    expect(text).toContain("env AWS_REGION=us-east-2");
    expect(text).toContain("env AWS_BEARER_TOKEN_BEDROCK=bedrock-key-e2e");
    expect(text).toContain("env E2E_PICKED=picked-value");
    expect(text).toContain("env E2E_NOT_PICKED=<unset>");
  });

  it("refuses a machines-only provider for work in a pod", async () => {
    const created = await api<{ provider: Provider }>("/api/model-providers", {
      method: "POST",
      body: JSON.stringify({
        name: "Laptops only",
        owner: "workspace",
        kind: "bedrock",
        agents: ["codex"],
        region: "us-west-2",
        localAwsProfile: "bedrock",
      }),
    });
    expect(created.status).toBe(201);
    const job = await api<{ error: string }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        name: "e2e laptops-only job",
        promptTemplate: "hi",
        agentRuntime: "codex",
        agentOptions: { modelProvider: created.body.provider.id },
      }),
    });
    expect(job.status).toBe(400);
    expect(job.body.error).toMatch(/machines only/);

    const listed = await api<{ providers: Array<{ name: string }> }>("/api/model-providers");
    expect(listed.body.providers.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Bedrock e2e", "Laptops only"]),
    );
    const del = await fetch(`${server.baseUrl}/api/model-providers/${created.body.provider.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
  });
});
