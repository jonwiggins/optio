import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who the bot is (settings.ts): never a person on GitLab unless an admin
 * names them, and on GitHub only a named user or the GitHub App's.
 */

const stored = new Map<string, unknown>();
vi.mock("../deployment-settings.js", () => ({
  getDeploymentSetting: async (key: string) => stored.get(key) ?? null,
  setDeploymentSetting: async (key: string, value: unknown) => {
    stored.set(key, value);
  },
}));
vi.mock("../git-token-service.js", () => ({ getGitToken: async () => "org-token" }));
vi.mock("../credential-health/inventory.js", () => ({ siteGitLabHosts: async () => [] }));
vi.mock("../github-app-service.js", () => ({
  isGitHubAppConfigured: () => false,
  generateJwt: async () => "jwt",
}));

import {
  botIdentity,
  forgetBotIdentities,
  githubBotIdentity,
  saveBotSettings,
} from "./settings.js";

const API = "https://gitlab.example.test/api/v4";
const mockFetch = vi.fn();
const user = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  stored.clear();
  forgetBotIdentities();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the GitLab bot's identity", () => {
  it("is the token's user when GitLab says it is a bot", async () => {
    mockFetch.mockResolvedValue(user({ id: 9, username: "project_42_bot", bot: true }));
    const { identity } = await botIdentity(API, null);
    expect(identity).toEqual({ id: 9, username: "project_42_bot", source: "token" });
  });

  it("refuses a person's token", async () => {
    mockFetch.mockResolvedValue(user({ id: 5, username: "alice", bot: false }));
    const { identity, error } = await botIdentity(API, null);
    expect(identity).toBeNull();
    expect(error).toMatch(/belongs to a person \(@alice\)/);
  });

  it("answers as a person only when an admin names them", async () => {
    await saveBotSettings("gitlab", { username: "alice" }, null);
    mockFetch.mockResolvedValue(user({ id: 5, username: "alice", bot: false }));
    const { identity } = await botIdentity(API, null);
    expect(identity).toMatchObject({ username: "alice", source: "app" });
  });

  it("an old GitLab that doesn't say is taken at its word", async () => {
    mockFetch.mockResolvedValue(user({ id: 9, username: "svc-optio" }));
    expect((await botIdentity(API, null)).identity?.username).toBe("svc-optio");
  });
});

describe("the GitHub bot's identity", () => {
  it("is unknown without a name or a GitHub App, whatever the token", async () => {
    const { identity, error } = await githubBotIdentity("https://api.github.com");
    expect(identity).toBeNull();
    expect(error).toMatch(/Name the GitHub bot/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("is the name the environment or an admin gives", async () => {
    vi.stubEnv("OPTIO_GITHUB_BOT_USERNAME", "optio-bot");
    expect((await githubBotIdentity("https://api.github.com")).identity).toMatchObject({
      username: "optio-bot",
      source: "environment",
    });
    await saveBotSettings("github", { username: "svc-bot" }, null);
    expect((await githubBotIdentity("https://api.github.com")).identity?.username).toBe("svc-bot");
  });
});
