import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** "Use my GitLab account for my work" (gitlab-user-token-service.ts): opt-in, refreshed, per host. */

const store = new Map<string, { value: string; version: string }>();
let version = 0;
vi.mock("./secret-service.js", () => ({
  storeSecret: async (name: string, value: string, scope: string) => {
    store.set(`${scope}|${name}`, { value, version: String(++version) });
  },
  retrieveSecret: async (name: string, scope: string) => {
    const v = store.get(`${scope}|${name}`);
    if (!v) throw new Error("not found");
    return v.value;
  },
  retrieveSecretVersioned: async (name: string, scope: string) => {
    const v = store.get(`${scope}|${name}`);
    if (!v) throw new Error("not found");
    return v;
  },
  deleteSecret: async (name: string, scope: string) => {
    store.delete(`${scope}|${name}`);
  },
  deleteSecretsIfUnchanged: async (
    names: string[],
    scope: string,
    guard: { name: string; version: string },
  ) => {
    if (store.get(`${scope}|${guard.name}`)?.version !== guard.version) return false;
    for (const n of names) store.delete(`${scope}|${n}`);
    return true;
  },
}));
vi.mock("./lease-service.js", () => ({
  LeaseLostError: class extends Error {},
  withLease: async (_key: string, fn: (s: AbortSignal) => Promise<unknown>) =>
    fn(new AbortController().signal),
}));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import {
  EXPIRES_AT,
  getUserGitLabToken,
  gitlabUserTokensEnabled,
  storeUserGitLabTokens,
} from "./gitlab-user-token-service.js";

const USER = "11111111-1111-1111-1111-111111111111";
const mockFetch = vi.fn();

beforeEach(() => {
  store.clear();
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
  vi.stubEnv("GITLAB_OAUTH_STORE_USER_TOKEN", "true");
  vi.stubEnv("GITLAB_OAUTH_BASE_URL", "https://gitlab.example.test");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_ID", "cid");
  vi.stubEnv("GITLAB_OAUTH_CLIENT_SECRET", "csecret");
  vi.stubEnv("PUBLIC_URL", "https://optio.example.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const expireIn = (ms: number) =>
  store.set(`user:${USER}|${EXPIRES_AT}`, {
    value: new Date(Date.now() + ms).toISOString(),
    version: String(++version),
  });

describe("the GitLab token from sign-in", () => {
  it("is off by default", async () => {
    vi.stubEnv("GITLAB_OAUTH_STORE_USER_TOKEN", "");
    expect(gitlabUserTokensEnabled()).toBe(false);
    await storeUserGitLabTokens(USER, { accessToken: "a1", refreshToken: "r1", expiresIn: 7200 });
    expect(await getUserGitLabToken(USER, "gitlab.example.test")).toBeNull();
  });

  it("is used on the GitLab sign-in uses, never another host", async () => {
    await storeUserGitLabTokens(USER, { accessToken: "a1", refreshToken: "r1", expiresIn: 7200 });
    expect(await getUserGitLabToken(USER, "gitlab.example.test")).toBe("a1");
    expect(await getUserGitLabToken(USER, "other.example.test")).toBeNull();
    expect(await getUserGitLabToken(USER, null)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("is refreshed five minutes before it expires, and the new pair is kept", async () => {
    await storeUserGitLabTokens(USER, { accessToken: "a1", refreshToken: "r1", expiresIn: 7200 });
    expireIn(4 * 60_000);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 7200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await getUserGitLabToken(USER, "gitlab.example.test")).toBe("a2");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://gitlab.example.test/oauth/token");
    expect(JSON.parse(init.body)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "r1",
      client_id: "cid",
    });
    expect(store.get(`user:${USER}|GITLAB_USER_OAUTH_REFRESH_TOKEN`)?.value).toBe("r2");
    expect(await getUserGitLabToken(USER, "gitlab.example.test")).toBe("a2");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("a revoked refresh token drops the stored tokens", async () => {
    await storeUserGitLabTokens(USER, { accessToken: "a1", refreshToken: "r1", expiresIn: 7200 });
    expireIn(-1000);
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await getUserGitLabToken(USER, "gitlab.example.test")).toBeNull();
    expect(store.has(`user:${USER}|GITLAB_USER_OAUTH_REFRESH_TOKEN`)).toBe(false);
  });

  it("a GitLab that can't be reached keeps them for the next try", async () => {
    await storeUserGitLabTokens(USER, { accessToken: "a1", refreshToken: "r1", expiresIn: 7200 });
    expireIn(-1000);
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await getUserGitLabToken(USER, "gitlab.example.test")).toBeNull();
    expect(store.get(`user:${USER}|GITLAB_USER_OAUTH_REFRESH_TOKEN`)?.value).toBe("r1");
  });
});
