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
vi.mock("../secret-service.js", () => ({ retrieveSecret: async () => "" }));
// The bot's calls go through the outbound guard; here, straight to the stub.
vi.mock("../../utils/outbound-url.js", () => ({
  guardedFetch: (url: string, init?: RequestInit) => fetch(url, init),
}));
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
    expect(error).toMatch(/\(@alice\) isn't a bot or service account/);
  });

  it("answers as a person only when an admin names them", async () => {
    await saveBotSettings("gitlab", { username: "alice" }, null);
    mockFetch.mockResolvedValue(user({ id: 5, username: "alice", bot: false }));
    const { identity } = await botIdentity(API, null);
    expect(identity).toMatchObject({ username: "alice", source: "app" });
  });

  it("refuses a token's user when GitLab doesn't say it is a bot (fails closed)", async () => {
    mockFetch.mockResolvedValue(user({ id: 9, username: "svc-optio" }));
    const { identity, error } = await botIdentity(API, null);
    expect(identity).toBeNull();
    expect(error).toMatch(/name the bot/);
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

describe("the GitLab hosts the bot answers on", () => {
  it("are the ones the deployment named, and gitlab.com only when it names none", async () => {
    const { botHosts, isNamedHost } = await import("./settings.js");
    vi.stubEnv("GITLAB_HOSTS", "");
    vi.stubEnv("OPTIO_GITLAB_HOSTS", "");
    expect(await botHosts()).toEqual(["gitlab.com"]);
    vi.stubEnv("GITLAB_HOSTS", "https://git.example.test:8443, other.example.test");
    const named = await botHosts();
    expect(named).toEqual(["git.example.test:8443", "other.example.test"]);
    // A self-managed GitLab's token never goes to gitlab.com then.
    expect(isNamedHost("gitlab.com", named)).toBe(false);
    expect(isNamedHost("git.example.test", named)).toBe(true);
    expect(isNamedHost("evil.example.test", named)).toBe(false);
  });
});
