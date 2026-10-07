import { describe, expect, it, vi } from "vitest";

vi.mock("./model-provider-service.js", () => ({
  podProviderRuntime: vi.fn(),
  resolveProviderForWork: vi.fn(),
}));
vi.mock("./secret-service.js", () => ({
  resolveSecretsForTask: vi.fn(),
  retrieveSecretWithFallback: vi.fn(),
}));

import { getAdapter } from "@optio/agent-adapters";
import { pooledProviderSecrets } from "./pooled-agent-env.js";

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
