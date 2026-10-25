import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ───

// `terminalWorkTeam` reads the task's / Job run's team.
const mockSelectRows = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
vi.mock("../db/client.js", () => {
  const chain = {
    from: () => chain,
    where: () => mockSelectRows(),
  };
  return { db: { select: () => chain } };
});
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./secret-service.js", () => ({
  retrieveSecret: vi.fn(),
  storeSecret: vi.fn(),
  resolveSecretsForTask: vi.fn(),
  retrieveSecretWithFallback: vi.fn(),
}));
const mockGetModelProviderRow = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock("./model-provider-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-provider-service.js")>();
  return {
    ...actual,
    getModelProviderRow: (...args: unknown[]) => mockGetModelProviderRow(...args),
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

import type { LocalTerminalSpec } from "@optio/shared";
import {
  allowsContextSuffix,
  applyGatewayEnv,
  applyGatewayRun,
  gatewayAuthSetup,
  gatewayClaudeSettings,
  gatewayForWork,
  gatewayPickForWork,
  gatewaySpawnSpec,
  resolveGatewayRun,
  terminalWorkTeam,
} from "./gateway-run-service.js";
import { GatewayTokenMissingError } from "./model-gateway-service.js";
import type { ModelProviderRow } from "./model-provider-service.js";

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
  localAwsProfile: null,
  models: {
    "claude-code": [
      {
        id: "acme-coder-large",
        label: "Coder (large)",
        contextWindow: 200000,
        maxOutputTokens: 32000,
        efforts: ["low", "medium", "high"],
        defaultEffort: "high",
        prices: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        role: "sonnet",
      },
      { id: "acme-coder-small", role: "haiku" },
      { id: "acme-gone", missing: true },
    ],
    opencode: [{ id: "acme-coder-large" }],
  },
} as unknown as ModelProviderRow;

const bedrock = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: "ws-1",
  ownerUserId: null,
  kind: "bedrock",
  name: "Bedrock",
  agents: ["claude-code"],
  region: "us-west-2",
  podCredential: "ambient",
  encryptedCredentials: null,
  models: {},
} as unknown as ModelProviderRow;

beforeEach(() => {
  mockSelectRows.mockReset();
  mockSelectRows.mockResolvedValue([]);
  mockGetModelProviderRow.mockReset();
  mockGetModelProviderRow.mockResolvedValue(gateway);
  mockDefaultGateway.mockReset();
  mockDefaultGateway.mockResolvedValue(gateway);
  mockResolveGatewayToken.mockReset();
  mockResolveGatewayToken.mockResolvedValue("sk-person");
});

// ─── Which gateway ───

describe("gatewayForWork", () => {
  it("is the picked gateway, the workspace's default when none is picked, and null for Bedrock", async () => {
    expect(await gatewayForWork({ agentType: "claude-code", workspaceId: "ws-1" })).toBe(gateway);
    expect(
      await gatewayForWork({ agentType: "claude-code", workspaceId: "ws-1", provider: gateway }),
    ).toBe(gateway);
    expect(
      await gatewayForWork({ agentType: "claude-code", workspaceId: "ws-1", provider: bedrock }),
    ).toBeNull();
    expect(mockDefaultGateway).toHaveBeenCalledTimes(1);
  });

  it("is null for an agent the gateway (or the gateway env) doesn't serve", async () => {
    expect(await gatewayForWork({ agentType: "gemini", workspaceId: "ws-1" })).toBeNull();
    mockDefaultGateway.mockResolvedValue({ ...gateway, agents: ["claude-code"] });
    expect(await gatewayForWork({ agentType: "opencode", workspaceId: "ws-1" })).toBeNull();
  });
});

// ─── Which model ───

describe("gatewayPickForWork", () => {
  it("takes the work's model with the effort the model takes, else the model's default", () => {
    expect(
      gatewayPickForWork(gateway, "claude-code", {
        claudeModel: "acme-coder-large",
        claudeEffort: "low",
      }),
    ).toEqual({ model: "acme-coder-large", effort: "low" });
    expect(
      gatewayPickForWork(gateway, "claude-code", {
        claudeModel: "acme-coder-large",
        claudeEffort: "max",
      }),
    ).toEqual({ model: "acme-coder-large", effort: "high" });
  });

  it("stands a Claude Code alias in for the catalog model with that role", () => {
    expect(gatewayPickForWork(gateway, "claude-code", { claudeModel: "haiku" })).toEqual({
      model: "acme-coder-small",
    });
    expect(gatewayPickForWork(gateway, "claude-code", null, "sonnet")).toMatchObject({
      model: "acme-coder-large",
    });
  });

  it("takes the first model the gateway still serves when the work names none", () => {
    expect(gatewayPickForWork(gateway, "opencode", null)).toEqual({ model: "acme-coder-large" });
    expect(
      gatewayPickForWork(
        {
          ...gateway,
          models: { "claude-code": [{ id: "x", missing: true }, { id: "y" }] },
        } as unknown as ModelProviderRow,
        "claude-code",
        null,
      ),
    ).toEqual({ model: "y" });
  });

  it("refuses a model the gateway doesn't serve, or takes the first with unservedModel: first", () => {
    expect(() =>
      gatewayPickForWork(gateway, "claude-code", { claudeModel: "claude-opus-4" }),
    ).toThrow('"Corp LiteLLM" doesn\'t serve the model "claude-opus-4"');
    expect(() => gatewayPickForWork(gateway, "claude-code", { claudeModel: "opus" })).toThrow(
      /doesn't serve the model "opus"/,
    );
    expect(
      gatewayPickForWork(gateway, "claude-code", { claudeModel: "claude-opus-4" }, null, "first"),
    ).toMatchObject({ model: "acme-coder-large" });
  });

  it("refuses an empty catalog either way", () => {
    const empty = { ...gateway, models: {} } as unknown as ModelProviderRow;
    expect(() => gatewayPickForWork(empty, "claude-code", null, null, "first")).toThrow(
      '"Corp LiteLLM" has no models for claude-code yet',
    );
  });
});

// ─── The run ───

describe("resolveGatewayRun", () => {
  it("resolves the token for the work's owner and builds the env", async () => {
    const run = await resolveGatewayRun({
      agentType: "claude-code",
      agentOptions: { claudeModel: "acme-coder-large", claudeEffort: "medium" },
      workspaceId: "ws-1",
      ownerUserId: "user-1",
      ownerTeamId: "team-1",
    });
    expect(mockResolveGatewayToken).toHaveBeenCalledWith({
      provider: gateway,
      workspaceId: "ws-1",
      ownerUserId: "user-1",
      ownerTeamId: "team-1",
    });
    expect(run).toMatchObject({
      row: gateway,
      agent: "claude-code",
      pick: { model: "acme-coder-large", effort: "medium" },
      token: "sk-person",
      env: {
        ANTHROPIC_BASE_URL: "https://litellm.example.com",
        ANTHROPIC_AUTH_TOKEN: "sk-person",
        ANTHROPIC_MODEL: "acme-coder-large",
        CLAUDE_CODE_SUBAGENT_MODEL: "acme-coder-large",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "acme-coder-small",
        CLAUDE_CODE_EFFORT_LEVEL: "medium",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000",
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
        DISABLE_TELEMETRY: "1",
      },
    });
    expect(run!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("is null when the work runs through no gateway, without asking for a token", async () => {
    mockDefaultGateway.mockResolvedValue(null);
    expect(
      await resolveGatewayRun({
        agentType: "claude-code",
        agentOptions: null,
        workspaceId: "ws-1",
        ownerUserId: "user-1",
      }),
    ).toBeNull();
    expect(mockResolveGatewayToken).not.toHaveBeenCalled();
  });

  it("refuses a model the work named, and takes the first for one it inherited", async () => {
    await expect(
      resolveGatewayRun({
        agentType: "claude-code",
        agentOptions: { claudeModel: "claude-opus-4" },
        workspaceId: "ws-1",
        ownerUserId: "user-1",
      }),
    ).rejects.toThrow(/doesn't serve the model/);
    const run = await resolveGatewayRun({
      agentType: "claude-code",
      agentOptions: null,
      fallbackModel: "claude-opus-4",
      workspaceId: "ws-1",
      ownerUserId: "user-1",
    });
    expect(run?.pick.model).toBe("acme-coder-large");
  });

  it("lets a missing token's message through", async () => {
    mockResolveGatewayToken.mockRejectedValue(
      new GatewayTokenMissingError(
        "The organization has no gateway token — an admin adds one under Settings → Model gateway",
        "global",
      ),
    );
    await expect(
      resolveGatewayRun({
        agentType: "claude-code",
        agentOptions: null,
        workspaceId: "ws-1",
        ownerUserId: null,
      }),
    ).rejects.toThrow("The organization has no gateway token");
  });

  it("gives OpenCode the OpenAI-compatible endpoint with the same token", async () => {
    const run = await resolveGatewayRun({
      agentType: "opencode",
      agentOptions: { opencodeModel: "acme-coder-large" },
      workspaceId: "ws-1",
      ownerUserId: "user-1",
    });
    expect(run?.env).toEqual({
      OPENAI_BASE_URL: "https://litellm.example.com/v1",
      OPENAI_API_KEY: "sk-person",
      OPTIO_OPENCODE_MODEL: "acme-coder-large",
    });
  });
});

// ─── The env ───

describe("applyGatewayEnv", () => {
  it("drops the deployment's key with a bearer token, and the OAuth token always", () => {
    const env = applyGatewayEnv(
      { ANTHROPIC_API_KEY: "sk-deployment", CLAUDE_CODE_OAUTH_TOKEN: "oauth", KEEP: "1" },
      { env: { ANTHROPIC_BASE_URL: "https://g", ANTHROPIC_AUTH_TOKEN: "sk-person" } },
    );
    expect(env).toEqual({
      KEEP: "1",
      ANTHROPIC_BASE_URL: "https://g",
      ANTHROPIC_AUTH_TOKEN: "sk-person",
    });
  });

  it("lets an api-key gateway's token replace the deployment's key", () => {
    const env = applyGatewayEnv(
      { ANTHROPIC_API_KEY: "sk-deployment", CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
      { env: { ANTHROPIC_BASE_URL: "https://g", ANTHROPIC_API_KEY: "sk-person" } },
    );
    expect(env).toEqual({ ANTHROPIC_BASE_URL: "https://g", ANTHROPIC_API_KEY: "sk-person" });
  });
});

describe("applyGatewayRun (a pooled pod's env)", () => {
  it("replaces the model, effort and settings with the catalog's for Claude Code", () => {
    const env = applyGatewayRun(
      {
        OPTIO_CLAUDE_MODEL: "sonnet",
        OPTIO_CLAUDE_CONTEXT_WINDOW: "1m",
        CLAUDE_CODE_EFFORT_LEVEL: "max",
        OPTIO_CLAUDE_SETTINGS_JSON: JSON.stringify({ effortLevel: "xhigh", other: true }),
        ANTHROPIC_API_KEY: "sk-deployment",
      },
      {
        agent: "claude-code",
        pick: { model: "acme-coder-large", effort: "high" },
        env: { ANTHROPIC_AUTH_TOKEN: "sk-person", CLAUDE_CODE_EFFORT_LEVEL: "high" },
      },
    );
    expect(env).toEqual({
      OPTIO_CLAUDE_MODEL: "acme-coder-large",
      CLAUDE_CODE_EFFORT_LEVEL: "high",
      ANTHROPIC_AUTH_TOKEN: "sk-person",
      OPTIO_CLAUDE_SETTINGS_JSON: JSON.stringify({
        other: true,
        skipWebFetchPreflight: true,
        effortLevel: "high",
      }),
    });
  });

  it("drops an effort the model doesn't take, and a custom OpenCode endpoint", () => {
    const claude = applyGatewayRun(
      { CLAUDE_CODE_EFFORT_LEVEL: "max", OPTIO_CLAUDE_SETTINGS_JSON: "not json" },
      { agent: "claude-code", pick: { model: "m" }, env: { ANTHROPIC_AUTH_TOKEN: "t" } },
    );
    expect(claude.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(JSON.parse(claude.OPTIO_CLAUDE_SETTINGS_JSON)).toEqual({ skipWebFetchPreflight: true });
    const opencode = applyGatewayRun(
      { OPTIO_OPENCODE_BASE_URL: "http://vllm:8000/v1", OPTIO_OPENCODE_MODEL: "old" },
      {
        agent: "opencode",
        pick: { model: "acme-coder-large" },
        env: { OPENAI_BASE_URL: "https://g/v1", OPENAI_API_KEY: "t" },
      },
    );
    expect(opencode).toEqual({
      OPTIO_OPENCODE_MODEL: "acme-coder-large",
      OPENAI_BASE_URL: "https://g/v1",
      OPENAI_API_KEY: "t",
    });
  });
});

describe("gatewayClaudeSettings / gatewayAuthSetup / allowsContextSuffix", () => {
  it("writes the effort up to xhigh and the preflight switch", () => {
    expect(gatewayClaudeSettings({ model: "m", effort: "max" })).toEqual({
      skipWebFetchPreflight: true,
    });
    expect(gatewayClaudeSettings({ model: "m", effort: "xhigh" })).toEqual({
      skipWebFetchPreflight: true,
      effortLevel: "xhigh",
    });
  });

  it("unsets the pod's key only on a bearer gateway run", () => {
    expect(gatewayAuthSetup({ OPTIO_AUTH_MODE: "gateway", ANTHROPIC_AUTH_TOKEN: "t" })).toEqual([
      "unset ANTHROPIC_API_KEY 2>/dev/null || true",
    ]);
    expect(gatewayAuthSetup({ OPTIO_AUTH_MODE: "gateway", ANTHROPIC_API_KEY: "t" })).toEqual([]);
    expect(gatewayAuthSetup({ OPTIO_AUTH_MODE: "api-key", ANTHROPIC_AUTH_TOKEN: "t" })).toEqual([]);
  });

  it("allows the [1m] suffix everywhere but a gateway run", () => {
    expect(allowsContextSuffix({ OPTIO_AUTH_MODE: "gateway" })).toBe(false);
    expect(allowsContextSuffix({ OPTIO_AUTH_MODE: "api-key" })).toBe(true);
    expect(allowsContextSuffix({})).toBe(true);
  });
});

// ─── On a machine ───

describe("gatewaySpawnSpec", () => {
  const terminal = { userId: "user-1", workspaceId: "ws-1", taskId: null, workflowRunId: null };
  const spec: LocalTerminalSpec = {
    kind: "agent",
    agent: "claude-code",
    prompt: "hi",
    model: "sonnet",
    effort: "max",
    provider: { kind: "gateway", providerId: gateway.id, name: gateway.name, region: "" },
  } as LocalTerminalSpec;

  it("completes the launch with the owner's token, the catalog's model and the effort it takes", async () => {
    const out = await gatewaySpawnSpec(terminal, spec);
    expect("spec" in out).toBe(true);
    const resolved = (out as { spec: LocalTerminalSpec }).spec;
    expect(resolved).toMatchObject({
      kind: "agent",
      model: "acme-coder-large",
      effort: "high",
      provider: {
        kind: "gateway",
        providerId: gateway.id,
        baseUrl: "https://litellm.example.com",
        authHeader: "bearer",
        env: {
          ANTHROPIC_BASE_URL: "https://litellm.example.com",
          ANTHROPIC_AUTH_TOKEN: "sk-person",
          ANTHROPIC_MODEL: "acme-coder-large",
          CLAUDE_CODE_EFFORT_LEVEL: "high",
        },
        // The catalog's ids and prices, for the machine's usage tracker.
        models: expect.arrayContaining([
          expect.objectContaining({ id: "acme-coder-large", prices: expect.anything() }),
        ]),
      },
    });
    expect(
      (resolved as Extract<LocalTerminalSpec, { kind: "agent" }>).provider!.models!.map(
        (m) => m.id,
      ),
    ).toEqual(["acme-coder-large", "acme-coder-small", "acme-gone"]);
    expect(mockResolveGatewayToken).toHaveBeenCalledWith({
      provider: gateway,
      workspaceId: "ws-1",
      ownerUserId: "user-1",
      ownerTeamId: null,
    });
  });

  it("carries the team's token for a team's Repo Task", async () => {
    mockSelectRows.mockResolvedValue([{ ownerTeamId: "team-1" }]);
    expect(await terminalWorkTeam({ taskId: "t1", workflowRunId: null })).toBe("team-1");
    await gatewaySpawnSpec({ ...terminal, taskId: "t1" }, spec);
    expect(mockResolveGatewayToken).toHaveBeenCalledWith(
      expect.objectContaining({ ownerTeamId: "team-1" }),
    );
  });

  it("says why the terminal can't start: a missing token, a gone gateway, an unserved agent", async () => {
    mockResolveGatewayToken.mockRejectedValue(
      new GatewayTokenMissingError("Add your gateway token under Settings → My tokens", "user"),
    );
    expect(await gatewaySpawnSpec(terminal, spec)).toEqual({
      error: "Add your gateway token under Settings → My tokens",
    });
    mockGetModelProviderRow.mockResolvedValue(null);
    expect(await gatewaySpawnSpec(terminal, spec)).toEqual({
      error: "The model gateway this session uses was removed — pick another",
    });
    mockGetModelProviderRow.mockResolvedValue(gateway);
    expect(
      await gatewaySpawnSpec(terminal, { ...spec, agent: "gemini" } as LocalTerminalSpec),
    ).toEqual({ error: '"Corp LiteLLM" isn\'t set up for gemini' });
  });

  it("passes any other spec through untouched", async () => {
    const shell: LocalTerminalSpec = { kind: "shell" };
    expect(await gatewaySpawnSpec(terminal, shell)).toEqual({ spec: shell });
    const onBedrock = {
      ...spec,
      provider: { kind: "bedrock", providerId: bedrock.id, name: "Bedrock", region: "us-west-2" },
    } as LocalTerminalSpec;
    expect(await gatewaySpawnSpec(terminal, onBedrock)).toEqual({ spec: onBedrock });
    expect(mockResolveGatewayToken).not.toHaveBeenCalled();
  });
});
