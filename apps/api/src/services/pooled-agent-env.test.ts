import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The provider pick is the work's (null = none); everything else is real, so
// a gateway run goes through `podProviderRuntime` / `gatewayRuntime` as in
// production.
const mockResolveProviderForWork = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock("./model-provider-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-provider-service.js")>();
  return {
    ...actual,
    resolveProviderForWork: (...args: unknown[]) => mockResolveProviderForWork(...args),
  };
});
const mockDefaultGateway = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const mockResolveGatewayToken = vi.fn(async (..._args: unknown[]): Promise<string> => "sk-person");
vi.mock("./model-gateway-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-gateway-service.js")>();
  return {
    ...actual,
    defaultGateway: (...args: unknown[]) => mockDefaultGateway(...args),
    resolveGatewayToken: (...args: unknown[]) => mockResolveGatewayToken(...args),
  };
});
// The gateway pre-flight asks the gateway itself (credential-health/gateway-preflight.ts,
// its own tests): no network here.
vi.mock("./credential-health/gateway-preflight.js", () => ({
  gatewayPreflight: async () => undefined,
}));
// The effort check's catalog: the baseline (no live probe in a unit test).
vi.mock("./agent-options-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-options-service.js")>();
  const { getProviderCatalog } = await import("@optio/shared");
  return {
    ...actual,
    getProviderOptions: vi.fn(async (provider: string) => ({
      catalog: getProviderCatalog(provider),
      source: "baseline",
      cached: false,
      refreshedAt: null,
    })),
  };
});
vi.mock("./agent-credential-service.js", () => ({
  resolveCredentialForWork: vi.fn(async () => null),
  credentialRuntime: vi.fn(),
}));
const mockResolveSecretsForTask = vi.fn(
  async (..._args: unknown[]): Promise<Record<string, string>> => ({}),
);
const mockRetrieveSecretWithFallback = vi.fn(
  async (..._args: unknown[]): Promise<string | null> => null,
);
vi.mock("./secret-service.js", () => ({
  resolveSecretsForTask: (...args: unknown[]) => mockResolveSecretsForTask(...args),
  retrieveSecretWithFallback: (...args: unknown[]) => mockRetrieveSecretWithFallback(...args),
  retrieveSecret: vi.fn(),
  storeSecret: vi.fn(),
}));

import { getAdapter } from "@optio/agent-adapters";
import { GatewayTokenMissingError } from "./model-gateway-service.js";
import type { ModelProviderRow } from "./model-provider-service.js";
import { pooledAgentEnv, pooledProviderSecrets } from "./pooled-agent-env.js";

const stored = (have: Record<string, string>) => async (name: string) => have[name] ?? null;
const opencode = (agentOptions: Record<string, string | boolean> | null) => ({
  agentRuntime: "opencode",
  agentOptions,
});

describe("pooledProviderSecrets", () => {
  it("OpenCode: any one provider key signs in", async () => {
    const out = await pooledProviderSecrets(
      getAdapter("opencode"),
      opencode(null),
      stored({ GROQ_API_KEY: "g" }),
      async () => {
        throw new Error("not for opencode");
      },
    );
    expect(out).toEqual({ GROQ_API_KEY: "g" });
  });

  it("OpenCode: a custom base URL needs no key", async () => {
    const out = await pooledProviderSecrets(
      getAdapter("opencode"),
      opencode({ opencodeBaseUrl: "http://llm.internal/v1" }),
      stored({}),
      async () => ({}),
    );
    expect(out).toEqual({});
  });

  it("OpenCode: no key and no base URL is a readable error, not a lookup of 'A or B'", async () => {
    await expect(
      pooledProviderSecrets(getAdapter("opencode"), opencode(null), stored({}), async () => ({})),
    ).rejects.toThrow(/ANTHROPIC_API_KEY, OPENAI_API_KEY or GROQ_API_KEY/);
  });

  it("other adapters resolve every name they report missing", async () => {
    const adapter = getAdapter("claude-code");
    const missing = adapter.validateSecrets([]).missing;
    const resolve = vi.fn(async (names: string[]) =>
      Object.fromEntries(names.map((n) => [n, "v"])),
    );
    const out = await pooledProviderSecrets(
      adapter,
      { agentRuntime: "claude-code", agentOptions: null },
      stored({}),
      resolve,
    );
    expect(resolve).toHaveBeenCalledWith(missing);
    expect(Object.keys(out)).toEqual(missing);
  });
});

describe("pooledProviderSecrets with a picked credential", () => {
  it("does not require the secret the credential provides", async () => {
    const resolve = vi.fn(async (names: string[]) =>
      Object.fromEntries(names.map((n) => [n, "v"])),
    );
    await pooledProviderSecrets(
      getAdapter("claude-code"),
      { agentRuntime: "claude-code", agentOptions: null },
      stored({}),
      resolve,
      { env: { ANTHROPIC_API_KEY: "picked" }, claudeAuthMode: "api-key" },
    );
    expect(resolve.mock.calls[0][0]).not.toContain("ANTHROPIC_API_KEY");
  });

  it("lets a Codex app-server credential run without an OpenAI key", async () => {
    const resolve = vi.fn(async (names: string[]) =>
      Object.fromEntries(names.map((n) => [n, "v"])),
    );
    await pooledProviderSecrets(
      getAdapter("codex"),
      { agentRuntime: "codex", agentOptions: null },
      stored({}),
      resolve,
      {
        env: { CODEX_APP_SERVER_URL: "http://as:1455" },
        codexAuthMode: "app-server",
        codexAppServerUrl: "http://as:1455",
      },
    );
    expect(resolve).toHaveBeenCalledWith([]);
  });
});

// ─── A gateway run (docs/model-gateway.md) ───

const gateway = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "ws-1",
  ownerUserId: null,
  kind: "gateway",
  name: "Corp LiteLLM",
  agents: ["claude-code", "opencode"],
  region: null,
  baseUrl: "https://litellm.example.com",
  authHeader: "bearer",
  syncUrl: null,
  tokenSource: "personal",
  encryptedCredentials: null,
  podCredential: "none",
  models: {
    "claude-code": [
      {
        id: "acme-coder-large",
        label: "Coder (large)",
        contextWindow: 200000,
        maxOutputTokens: 32000,
        efforts: ["low", "medium", "high"],
        defaultEffort: "high",
        role: "sonnet",
      },
      { id: "acme-coder-small", role: "haiku" },
    ],
    opencode: [{ id: "acme-coder-large" }],
  },
} as unknown as ModelProviderRow;

describe("pooledAgentEnv through the model gateway", () => {
  beforeEach(() => {
    mockResolveProviderForWork.mockReset();
    mockResolveProviderForWork.mockResolvedValue(null);
    mockDefaultGateway.mockReset();
    mockDefaultGateway.mockResolvedValue(gateway);
    mockResolveGatewayToken.mockReset();
    mockResolveGatewayToken.mockResolvedValue("sk-person");
    mockResolveSecretsForTask.mockReset();
    mockResolveSecretsForTask.mockResolvedValue({});
    mockRetrieveSecretWithFallback.mockReset();
    mockRetrieveSecretWithFallback.mockResolvedValue(null);
  });

  it("gives a Claude Code run the gateway's env with the owner's token, and no other sign-in", async () => {
    // The deployment holds a key and an OAuth token: neither reaches the pod.
    mockRetrieveSecretWithFallback.mockImplementation(async (name: unknown) =>
      name === "ANTHROPIC_API_KEY"
        ? "sk-deployment"
        : name === "CLAUDE_CODE_OAUTH_TOKEN"
          ? "oauth-deployment"
          : null,
    );
    const env = await pooledAgentEnv(
      {
        agentRuntime: "claude-code",
        agentOptions: { claudeModel: "acme-coder-large", claudeEffort: "max" },
      },
      "do the thing",
      "ws-1",
      "user-1",
      "team-1",
    );
    expect(mockResolveGatewayToken).toHaveBeenCalledWith({
      provider: gateway,
      workspaceId: "ws-1",
      ownerUserId: "user-1",
      ownerTeamId: "team-1",
    });
    expect(env).toMatchObject({
      OPTIO_PROMPT: "do the thing",
      OPTIO_AGENT_TYPE: "claude-code",
      OPTIO_AUTH_MODE: "gateway",
      OPTIO_CLAUDE_MODEL: "acme-coder-large",
      ANTHROPIC_BASE_URL: "https://litellm.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-person",
      ANTHROPIC_MODEL: "acme-coder-large",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "acme-coder-large",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "acme-coder-small",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "acme-coder-large",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // "max" isn't among the model's efforts: its default stands instead.
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
    expect(JSON.parse(env.OPTIO_CLAUDE_SETTINGS_JSON)).toEqual({
      skipWebFetchPreflight: true,
      effortLevel: "high",
    });
    // No sign-in secret was even looked up.
    expect(mockRetrieveSecretWithFallback).not.toHaveBeenCalledWith(
      "ANTHROPIC_API_KEY",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(mockResolveSecretsForTask).not.toHaveBeenCalled();
  });

  it("maps a Claude Code alias to the catalog model with that role, and the legacy model column too", async () => {
    const env = await pooledAgentEnv(
      { agentRuntime: "claude-code", agentOptions: null, model: "haiku" },
      "p",
      "ws-1",
      "user-1",
    );
    expect(env.OPTIO_CLAUDE_MODEL).toBe("acme-coder-small");
    expect(env.ANTHROPIC_MODEL).toBe("acme-coder-small");
  });

  it("refuses a model the work named that the gateway doesn't serve", async () => {
    await expect(
      pooledAgentEnv(
        { agentRuntime: "claude-code", agentOptions: { claudeModel: "claude-opus-4" } },
        "p",
        "ws-1",
        "user-1",
      ),
    ).rejects.toThrow('"Corp LiteLLM" doesn\'t serve the model "claude-opus-4"');
  });

  it("fails with the token's own message when the owner has none", async () => {
    mockResolveGatewayToken.mockRejectedValue(
      new GatewayTokenMissingError("Add your gateway token under Settings → My tokens", "user"),
    );
    await expect(
      pooledAgentEnv({ agentRuntime: "claude-code", agentOptions: null }, "p", "ws-1", "user-1"),
    ).rejects.toThrow("Add your gateway token under Settings → My tokens");
  });

  it("points OpenCode at the gateway's OpenAI-compatible endpoint, over any custom base URL", async () => {
    const env = await pooledAgentEnv(
      {
        agentRuntime: "opencode",
        agentOptions: { opencodeModel: "acme-coder-large", opencodeBaseUrl: "http://vllm:8000/v1" },
      },
      "p",
      "ws-1",
      "user-1",
    );
    expect(env).toMatchObject({
      OPTIO_AUTH_MODE: "gateway",
      OPENAI_BASE_URL: "https://litellm.example.com/v1",
      OPENAI_API_KEY: "sk-person",
      OPTIO_OPENCODE_MODEL: "acme-coder-large",
    });
    expect(env.OPTIO_OPENCODE_BASE_URL).toBeUndefined();
    expect(mockResolveSecretsForTask).not.toHaveBeenCalled();
  });

  it("leaves an agent the gateway doesn't serve on its own sign-in", async () => {
    mockResolveSecretsForTask.mockResolvedValue({ GEMINI_API_KEY: "g" });
    const env = await pooledAgentEnv(
      { agentRuntime: "gemini", agentOptions: null },
      "p",
      "ws-1",
      "user-1",
    );
    expect(mockResolveGatewayToken).not.toHaveBeenCalled();
    expect(env.OPTIO_AUTH_MODE).toBe("api-key");
    expect(env.GEMINI_API_KEY).toBe("g");
  });

  it("without a gateway, Claude Code signs in as before", async () => {
    mockDefaultGateway.mockResolvedValue(null);
    mockResolveSecretsForTask.mockResolvedValue({ ANTHROPIC_API_KEY: "sk-deployment" });
    mockRetrieveSecretWithFallback.mockImplementation(async (name: unknown) =>
      name === "ANTHROPIC_API_KEY" ? "sk-deployment" : null,
    );
    const env = await pooledAgentEnv(
      { agentRuntime: "claude-code", agentOptions: { claudeModel: "sonnet" } },
      "p",
      "ws-1",
      "user-1",
    );
    expect(env.OPTIO_AUTH_MODE).toBe("api-key");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-deployment");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.OPTIO_CLAUDE_MODEL).toBe("sonnet");
  });
});

describe("pooledAgentEnv: an effort the model doesn't take", () => {
  beforeEach(() => {
    mockResolveProviderForWork.mockReset();
    mockResolveProviderForWork.mockResolvedValue(null);
    mockDefaultGateway.mockReset();
    mockDefaultGateway.mockResolvedValue(null);
    mockResolveGatewayToken.mockReset();
    mockResolveGatewayToken.mockResolvedValue("sk-person");
    mockRetrieveSecretWithFallback.mockReset();
    mockRetrieveSecretWithFallback.mockResolvedValue("sk-deployment");
  });

  it("drops a repo's effort for a model that takes none (Haiku 4.5)", async () => {
    const env = await pooledAgentEnv(
      { agentRuntime: "claude-code", agentOptions: { claudeModel: "haiku", claudeEffort: "high" } },
      "p",
      "ws-1",
      null,
    );
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(env.OPTIO_CLAUDE_SETTINGS_JSON).toBeUndefined();
  });

  it("keeps it for a model that takes it", async () => {
    const env = await pooledAgentEnv(
      { agentRuntime: "claude-code", agentOptions: { claudeModel: "opus", claudeEffort: "high" } },
      "p",
      "ws-1",
      null,
    );
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
    expect(JSON.parse(env.OPTIO_CLAUDE_SETTINGS_JSON)).toEqual({ effortLevel: "high" });
  });

  it("a gateway model that lists no efforts gets none, even with a default", async () => {
    mockDefaultGateway.mockResolvedValue({
      ...gateway,
      models: { "claude-code": [{ id: "plain-model", defaultEffort: "high" }] },
    });
    const env = await pooledAgentEnv(
      {
        agentRuntime: "claude-code",
        agentOptions: { claudeModel: "plain-model", claudeEffort: "high" },
      },
      "p",
      "ws-1",
      "user-1",
    );
    expect(env.OPTIO_CLAUDE_MODEL).toBe("plain-model");
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(JSON.parse(env.OPTIO_CLAUDE_SETTINGS_JSON)).toEqual({ skipWebFetchPreflight: true });
  });
});
