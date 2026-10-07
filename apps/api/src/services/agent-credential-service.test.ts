import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("./model-provider-service.js", () => ({ listModelProviders: vi.fn() }));
vi.mock("./secret-service.js", () => ({
  retrieveSecretById: vi.fn(),
  retrieveSecretWithFallback: vi.fn(),
  storeSecret: vi.fn(),
}));

import { secretCredentialId, secretIdFromCredential } from "@optio/shared";
import {
  credentialRuntime,
  credentialSpec,
  credentialSpecs,
  resolveCredentialForWork,
  verifyAgentCredential,
} from "./agent-credential-service.js";
import { retrieveSecretById } from "./secret-service.js";

const ID = "22222222-2222-4222-8222-222222222222";

describe("credential catalog", () => {
  it("names each agent's sign-in secrets in picker order", () => {
    expect(credentialSpecs("claude-code").map((s) => s.secretName)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CLAUDE_VERTEX_PROJECT_ID",
    ]);
    expect(credentialSpecs("codex").map((s) => s.method)).toEqual(["api-key", "app-server"]);
    expect(credentialSpecs("opencode")).toHaveLength(3);
    expect(credentialSpecs("terminal")).toEqual([]);
  });

  it("keeps Vertex projects listable but not addable from the modal", () => {
    expect(credentialSpec("claude-code", "CLAUDE_VERTEX_PROJECT_ID")?.addable).toBe(false);
    expect(credentialSpec("claude-code", "ANTHROPIC_API_KEY")?.addable).toBe(true);
    expect(credentialSpec("claude-code", "GITHUB_TOKEN")).toBeNull();
  });
});

describe("credentialRuntime", () => {
  it("maps a Claude pick onto its auth mode and env var", () => {
    expect(
      credentialRuntime("claude-code", { secretName: "CLAUDE_CODE_OAUTH_TOKEN", value: "t" }),
    ).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, claudeAuthMode: "oauth-token" });
    expect(
      credentialRuntime("claude-code", { secretName: "ANTHROPIC_API_KEY", value: "k" }),
    ).toEqual({ env: { ANTHROPIC_API_KEY: "k" }, claudeAuthMode: "api-key" });
  });

  it("maps a Codex app-server pick onto the flag the launchers read", () => {
    expect(
      credentialRuntime("codex", { secretName: "CODEX_APP_SERVER_URL", value: "http://as:1455" }),
    ).toEqual({
      env: { CODEX_APP_SERVER_URL: "http://as:1455" },
      codexAuthMode: "app-server",
      codexAppServerUrl: "http://as:1455",
    });
    expect(credentialRuntime("codex", { secretName: "OPENAI_API_KEY", value: "k" })).toEqual({
      env: { OPENAI_API_KEY: "k" },
      codexAuthMode: "api-key",
    });
  });

  it("gives agents without modes just the env var", () => {
    expect(credentialRuntime("opencode", { secretName: "GROQ_API_KEY", value: "g" })).toEqual({
      env: { GROQ_API_KEY: "g" },
    });
  });
});

describe("resolveCredentialForWork", () => {
  const use = {
    agentType: "claude-code",
    workspaceId: "ws",
    ownerUserId: "alice",
    runsOn: "pod" as const,
  };

  it("is null when the work picks none", async () => {
    expect(await resolveCredentialForWork({ ...use, agentOptions: null })).toBeNull();
    expect(await resolveCredentialForWork({ ...use, agentOptions: { credential: "" } })).toBeNull();
  });

  it("rejects a malformed value, a provider picked as well, and work on a machine", async () => {
    await expect(
      resolveCredentialForWork({ ...use, agentOptions: { credential: "nope" } }),
    ).rejects.toThrow(/secret:<id>/);
    await expect(
      resolveCredentialForWork({
        ...use,
        agentOptions: { credential: secretCredentialId(ID), modelProvider: ID },
      }),
    ).rejects.toThrow(/one sign-in/);
    await expect(
      resolveCredentialForWork({
        ...use,
        runsOn: "local",
        agentOptions: { credential: secretCredentialId(ID) },
      }),
    ).rejects.toThrow(/machine/);
  });

  it("checks the row's owner against the work's and the name against the agent", async () => {
    const row = (over: Record<string, unknown>) => ({
      row: {
        id: ID,
        name: "ANTHROPIC_API_KEY",
        scope: "user",
        userId: "alice",
        workspaceId: null,
        ...over,
      },
      value: "sk-1",
    });
    vi.mocked(retrieveSecretById).mockResolvedValueOnce(row({}) as never);
    const picked = await resolveCredentialForWork({
      ...use,
      agentOptions: { credential: secretCredentialId(ID) },
    });
    expect(picked).toMatchObject({ secretName: "ANTHROPIC_API_KEY", value: "sk-1" });

    vi.mocked(retrieveSecretById).mockResolvedValueOnce(row({}) as never);
    await expect(
      resolveCredentialForWork({
        ...use,
        ownerUserId: null,
        agentOptions: { credential: secretCredentialId(ID) },
      }),
    ).rejects.toThrow(/own credential/);

    vi.mocked(retrieveSecretById).mockResolvedValueOnce(row({ name: "GITHUB_TOKEN" }) as never);
    await expect(
      resolveCredentialForWork({ ...use, agentOptions: { credential: secretCredentialId(ID) } }),
    ).rejects.toThrow(/isn't a credential claude-code takes/);

    vi.mocked(retrieveSecretById).mockResolvedValueOnce(null);
    await expect(
      resolveCredentialForWork({ ...use, agentOptions: { credential: secretCredentialId(ID) } }),
    ).rejects.toThrow(/removed/);
  });
});

describe("verifyAgentCredential", () => {
  const respond = (status: number, body: unknown) => async (): Promise<Response> =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

  it("asks the provider for its model list and reports the count, never the value", async () => {
    const fetchImpl = vi.fn<typeof fetch>(respond(200, { data: [{}, {}, {}] }));
    const result = await verifyAgentCredential(
      { agentType: "claude-code", secretName: "ANTHROPIC_API_KEY", value: "sk-ant-x" },
      fetchImpl,
    );
    expect(result).toEqual({ valid: true, detail: "3 models" });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/models");
  });

  it("passes the service's reason through on a refusal", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      respond(401, { error: { message: "invalid x-api-key" } }),
    );
    const result = await verifyAgentCredential(
      { agentType: "opencode", secretName: "OPENAI_API_KEY", value: "sk-x" },
      fetchImpl,
    );
    expect(result).toEqual({ valid: false, error: "invalid x-api-key" });
  });

  it("does not check what cannot be checked", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(
      await verifyAgentCredential(
        { agentType: "claude-code", secretName: "CLAUDE_CODE_OAUTH_TOKEN", value: "t" },
        fetchImpl,
      ),
    ).toEqual({ valid: true, detail: "not checked" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await verifyAgentCredential(
        { agentType: "claude-code", secretName: "NOPE", value: "t" },
        fetchImpl,
      ),
    ).toMatchObject({ valid: false });
  });

  it("reads a secret credential id", () => {
    expect(secretIdFromCredential(secretCredentialId(ID))).toBe(ID);
    expect(secretIdFromCredential("provider:" + ID)).toBeNull();
    expect(secretIdFromCredential(undefined)).toBeNull();
  });
});
