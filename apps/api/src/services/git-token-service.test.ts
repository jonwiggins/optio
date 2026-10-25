import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Stored secrets, keyed `<name>|<scope>|<owner>` (owner: user / team id, workspace id, or "-"). */
let stored: Record<string, string> = {};
const notFound = () => Promise.reject(new Error("Secret not found"));

vi.mock("./secret-service.js", () => ({
  retrieveSecret: vi.fn(
    async (
      name: string,
      scope: string,
      workspaceId?: string | null,
      userId?: string | null,
      teamId?: string | null,
    ) => {
      const owner = scope === "team" ? teamId : scope === "user" ? userId : (workspaceId ?? "-");
      const hit = stored[`${name}|${scope}|${owner}`];
      return hit ?? notFound();
    },
  ),
  // The legacy name was read at scope `user:<id>`, the organization's at
  // workspace then global.
  retrieveSecretWithFallback: vi.fn(
    async (name: string, scope: string, workspaceId?: string | null) => {
      const hit =
        (workspaceId && stored[`${name}|${scope}|${workspaceId}`]) || stored[`${name}|${scope}|-`];
      return hit ?? notFound();
    },
  ),
}));
const getGitHubToken = vi.fn(async (_opts: unknown) => "gh-token");
vi.mock("./github-token-service.js", () => ({
  getGitHubToken: (opts: unknown) => getGitHubToken(opts),
}));
vi.mock("./codecommit-credential-service.js", () => ({
  getCodeCommitCredentials: vi.fn(async () => "cc"),
}));
vi.mock("./git-platform/index.js", () => ({ createGitPlatform: vi.fn() }));
/** The repos table: repo URL → recorded git_platform. */
let recorded: Record<string, string> = {};
/** The GitLab repos (`git_platform = 'gitlab'`), for the known-host check. */
let gitlabRepos: Array<{ repoUrl: string; workspaceId: string | null }> = [];
const repoLookups = vi.fn();
vi.mock("drizzle-orm", async (orig) => ({
  ...(await orig<typeof import("drizzle-orm")>()),
  eq: (_column: unknown, value: unknown) => ({ value }),
}));
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: ({ value }: { value: string }) =>
          Object.assign(Promise.resolve(value === "gitlab" ? gitlabRepos : []), {
            limit: async () => {
              repoLookups(value);
              return recorded[value] ? [{ gitPlatform: recorded[value] }] : [];
            },
          }),
      }),
    }),
  },
}));

import {
  getGitPlatformForRepo,
  getGitToken,
  gitLabTokenNameForHost,
  isKnownGitLabHost,
} from "./git-token-service.js";

const all = () => ({
  "GITLAB_TOKEN|team|team-1": "team-token",
  "GITLAB_TOKEN|user|user-1": "user-token",
  "GITLAB_USER_ACCESS_TOKEN|user:user-1|-": "legacy-user-token",
  "GITLAB_TOKEN|global|ws-1": "workspace-token",
  "GITLAB_TOKEN|global|-": "org-token",
});

beforeEach(() => {
  stored = all();
  process.env.GITLAB_TOKEN = "env-token";
});
afterEach(() => {
  delete process.env.GITLAB_TOKEN;
});

const gitlab = (ctx: Parameters<typeof getGitToken>[1]) => getGitToken("gitlab", ctx);

describe("getGitToken (GitLab)", () => {
  it("a team's work uses the team's token", async () => {
    expect(await gitlab({ userId: "user-1", ownerTeamId: "team-1", workspaceId: "ws-1" })).toBe(
      "team-token",
    );
  });

  it("then the person's own, under GITLAB_TOKEN", async () => {
    expect(await gitlab({ userId: "user-1", workspaceId: "ws-1" })).toBe("user-token");
  });

  it("still honours a personal token saved under the older name", async () => {
    delete stored["GITLAB_TOKEN|user|user-1"];
    expect(await gitlab({ userId: "user-1", workspaceId: "ws-1" })).toBe("legacy-user-token");
  });

  it("then the workspace's, then the organization's", async () => {
    expect(await gitlab({ workspaceId: "ws-1" })).toBe("workspace-token");
    delete stored["GITLAB_TOKEN|global|ws-1"];
    expect(await gitlab({ workspaceId: "ws-1" })).toBe("org-token");
  });

  it("a team without a token falls to the organization's, not the creator's", async () => {
    delete stored["GITLAB_TOKEN|team|team-1"];
    expect(await gitlab({ userId: "user-1", ownerTeamId: "team-1", workspaceId: "ws-1" })).toBe(
      "workspace-token",
    );
  });

  it("server calls skip personal tokens", async () => {
    expect(await gitlab({ userId: "user-1", server: true, workspaceId: "ws-1" })).toBe(
      "workspace-token",
    );
  });

  it("then the env var, then a clear error", async () => {
    stored = {};
    expect(await gitlab({ userId: "user-1" })).toBe("env-token");
    delete process.env.GITLAB_TOKEN;
    await expect(gitlab({ userId: "user-1" })).rejects.toThrow("No GitLab token available");
  });

  it("ownOnly: the team's or the person's own, never the organization's or the env var", async () => {
    const own = { userId: "user-1", workspaceId: "ws-1", ownOnly: true };
    expect(await gitlab(own)).toBe("user-token");
    expect(await gitlab({ ...own, ownerTeamId: "team-1" })).toBe("team-token");
    delete stored["GITLAB_TOKEN|team|team-1"];
    await expect(gitlab({ ...own, ownerTeamId: "team-1" })).rejects.toThrow(
      "No GitLab token of the team's own",
    );
    delete stored["GITLAB_TOKEN|user|user-1"];
    delete stored["GITLAB_USER_ACCESS_TOKEN|user:user-1|-"];
    await expect(gitlab(own)).rejects.toThrow("No GitLab token of the person's own");
    // Without an owner there is nothing of its own: the organization's, as before.
    expect(await gitlab({ workspaceId: "ws-1", ownOnly: true })).toBe("workspace-token");
  });
});

describe("isKnownGitLabHost", () => {
  beforeEach(() => {
    gitlabRepos = [];
    vi.stubEnv("OPTIO_PROFILE", "full");
    vi.stubEnv("GITLAB_HOSTS", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a host nobody named and no GitLab repo uses", async () => {
    expect(await isKnownGitLabHost("evil.example", "ws-1")).toBe(false);
    expect(await isKnownGitLabHost("", "ws-1")).toBe(false);
  });

  it("knows gitlab.com under the full profile only", async () => {
    expect(await isKnownGitLabHost("https://GitLab.com/", "ws-1")).toBe(true);
    vi.stubEnv("OPTIO_PROFILE", "standard");
    expect(await isKnownGitLabHost("gitlab.com", "ws-1")).toBe(false);
  });

  it("knows a named host (GITLAB_HOSTS, the GITLAB_HOST secret), with a port or a path prefix", async () => {
    vi.stubEnv("GITLAB_HOSTS", "gitlab.corp:8443");
    expect(await isKnownGitLabHost("gitlab.corp", "ws-1")).toBe(true);
    stored["GITLAB_HOST|global|-"] = "https://git.site.example";
    expect(await isKnownGitLabHost("git.site.example:8443/gitlab", "ws-1")).toBe(true);
  });

  it("knows the host of a GitLab repo added to the provider's workspace", async () => {
    gitlabRepos = [{ repoUrl: "https://git.example.com:8443/g/sub/app", workspaceId: "ws-1" }];
    expect(await isKnownGitLabHost("git.example.com", "ws-1")).toBe(true);
    expect(await isKnownGitLabHost("git.example.com", "ws-2")).toBe(false);
    expect(await isKnownGitLabHost("git.example.com", null)).toBe(true);
  });
});

describe("getGitToken (GitLab, a token per host)", () => {
  it("names a host's token GITLAB_TOKEN_<HOST>", () => {
    expect(gitLabTokenNameForHost("gitlab.com")).toBe("GITLAB_TOKEN_GITLAB_COM");
    expect(gitLabTokenNameForHost("https://git.example.com:8443/")).toBe(
      "GITLAB_TOKEN_GIT_CORP_EXAMPLE_8443",
    );
  });

  it("at each scope, the host's token comes before the plain one", async () => {
    stored["GITLAB_TOKEN_GIT_CORP|user|user-1"] = "user-corp-token";
    stored["GITLAB_TOKEN_GIT_CORP|global|-"] = "org-corp-token";
    expect(await gitlab({ userId: "user-1", host: "git.corp" })).toBe("user-corp-token");
    // Another host: the plain names, as before
    expect(await gitlab({ userId: "user-1", host: "gitlab.com" })).toBe("user-token");
    // No personal token for this host: the person's plain one still wins over the org's
    delete stored["GITLAB_TOKEN_GIT_CORP|user|user-1"];
    expect(await gitlab({ userId: "user-1", host: "git.corp" })).toBe("user-token");
    expect(await gitlab({ server: true, workspaceId: "ws-1", host: "git.corp" })).toBe(
      "org-corp-token",
    );
  });

  it("a team's host token, and the host's env var", async () => {
    stored["GITLAB_TOKEN_GIT_CORP|team|team-1"] = "team-corp-token";
    expect(await gitlab({ userId: "user-1", ownerTeamId: "team-1", host: "git.corp" })).toBe(
      "team-corp-token",
    );
    stored = {};
    process.env.GITLAB_TOKEN_GIT_CORP = "env-corp-token";
    try {
      expect(await gitlab({ host: "git.corp" })).toBe("env-corp-token");
      expect(await gitlab({ host: "gitlab.com" })).toBe("env-token");
    } finally {
      delete process.env.GITLAB_TOKEN_GIT_CORP;
    }
  });
});

describe("getGitToken (GitHub)", () => {
  it("is untouched: the GitHub token service decides", async () => {
    expect(await getGitToken("github", { userId: "user-1", ownerTeamId: "team-1" })).toBe(
      "gh-token",
    );
    expect(getGitHubToken).toHaveBeenCalledWith({ userId: "user-1", workspaceId: undefined });
  });
});

describe("getGitPlatformForRepo", () => {
  beforeEach(() => {
    recorded = {};
    repoLookups.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses the platform recorded for a repo on a host nothing names", async () => {
    recorded["https://git.example.com/group/sub/app"] = "gitlab";
    const { ri } = await getGitPlatformForRepo("https://git.example.com/group/sub/app.git", {
      server: true,
    });
    expect(ri).toMatchObject({
      platform: "gitlab",
      owner: "group/sub",
      repo: "app",
      apiBaseUrl: "https://git.example.com/api/v4",
    });
  });

  it("keeps the URL's guess when nothing is recorded", async () => {
    const { ri } = await getGitPlatformForRepo("https://git.example.com/acme/app", {
      server: true,
    });
    expect(ri.platform).toBe("github");
  });

  it("never looks up a known host, and a known host wins over the hint", async () => {
    const { ri } = await getGitPlatformForRepo("https://github.com/acme/gitlab-tools", {
      server: true,
      platformHint: "gitlab",
    });
    expect(ri).toMatchObject({ platform: "github", owner: "acme", repo: "gitlab-tools" });
    await getGitPlatformForRepo("https://gitlab.com/acme/app", { server: true });
    expect(repoLookups).not.toHaveBeenCalled();
  });

  it("lays the GitLab scope over the context for a GitLab repo only", async () => {
    const scope = { gitlabScope: { workspaceId: "ws-1", ownerTeamId: "team-1" } };
    getGitHubToken.mockClear();
    await getGitPlatformForRepo("https://github.com/acme/app", { server: true, ...scope });
    expect(getGitHubToken).toHaveBeenCalledWith({ server: true, workspaceId: undefined });
    const { createGitPlatform } = await import("./git-platform/index.js");
    await getGitPlatformForRepo("https://gitlab.com/acme/app", { server: true, ...scope });
    expect(createGitPlatform).toHaveBeenLastCalledWith("gitlab", "team-token");
    await getGitPlatformForRepo("https://gitlab.com/acme/app", { server: true });
    expect(createGitPlatform).toHaveBeenLastCalledWith("gitlab", "org-token");
  });

  it("parses with the caller's hint (subgroups, the API base)", async () => {
    const { ri } = await getGitPlatformForRepo("https://git.example.com/a/b/c", {
      server: true,
      platformHint: "gitlab",
    });
    expect(ri).toMatchObject({ platform: "gitlab", owner: "a/b", repo: "c" });
    expect(repoLookups).not.toHaveBeenCalled();
  });
});

const signIn = vi.hoisted(() => ({
  on: false,
  token: vi.fn(async (_userId: string, _host?: string | null): Promise<string | null> => null),
}));
vi.mock("./gitlab-user-token-service.js", () => ({
  gitlabUserTokensEnabled: () => signIn.on,
  getUserGitLabToken: (userId: string, host?: string | null) => signIn.token(userId, host),
}));

describe("getGitToken (GitLab, the token from sign-in)", () => {
  beforeEach(() => {
    signIn.on = true;
    signIn.token.mockReset();
    signIn.token.mockResolvedValue("signin-token");
    delete stored["GITLAB_TOKEN|user|user-1"];
    delete stored["GITLAB_USER_ACCESS_TOKEN|user:user-1|-"];
  });
  afterEach(() => {
    signIn.on = false;
  });

  it("comes after the person's own saved token and before the organization's", async () => {
    expect(await gitlab({ userId: "user-1", workspaceId: "ws-1", host: "gitlab.com" })).toBe(
      "signin-token",
    );
    expect(signIn.token).toHaveBeenCalledWith("user-1", "gitlab.com");
    stored["GITLAB_TOKEN|user|user-1"] = "user-token";
    expect(await gitlab({ userId: "user-1", workspaceId: "ws-1", host: "gitlab.com" })).toBe(
      "user-token",
    );
  });

  it("is never asked for a team's work or a server call, nor while the option is off", async () => {
    await gitlab({ userId: "user-1", ownerTeamId: "team-1", workspaceId: "ws-1" });
    await gitlab({ userId: "user-1", server: true, workspaceId: "ws-1" });
    signIn.on = false;
    expect(await gitlab({ userId: "user-1", workspaceId: "ws-1" })).toBe("workspace-token");
    expect(signIn.token).not.toHaveBeenCalled();
  });

  it("missing (another host, nothing stored), the organization's follows", async () => {
    signIn.token.mockResolvedValue(null);
    expect(await gitlab({ userId: "user-1", workspaceId: "ws-1", host: "git.example.test" })).toBe(
      "workspace-token",
    );
  });
});
