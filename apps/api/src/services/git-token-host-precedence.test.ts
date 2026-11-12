import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Stored secrets, keyed `<name>|<scope>|<owner>` (owner: user / team id, workspace id, or "-"). */
let stored: Record<string, string> = {};
/** Deployment secrets (owner "-") a deployment admin shared with every workspace, by name. */
let shared = new Set<string>();
const notFound = () => Promise.reject(new Error("Secret not found"));

vi.mock("./secret-service.js", () => ({
  WORKSPACE_SECRET_SCOPE: "workspace",
  retrieveSecret: vi.fn(
    async (
      name: string,
      scope: string,
      workspaceId?: string | null,
      userId?: string | null,
      opts?: { sharedOnly?: boolean },
    ) => {
      const owner = scope === "user" ? userId : (workspaceId ?? "-");
      if (opts?.sharedOnly && !shared.has(name)) return notFound();
      const hit = stored[`${name}|${scope}|${owner}`];
      return hit ?? notFound();
    },
  ),
  // Only the legacy `user:<id>` name is read through the fallback now.
  retrieveSecretWithFallback: vi.fn(async (name: string, scope: string) => {
    const hit = stored[`${name}|${scope}|-`];
    return hit ?? notFound();
  }),
}));
// The real rule reads the founding workspace from the database
// (workspace-gitlab-service.int.test.ts); here ws-1 founded it.
const FOUNDING = "ws-1";
vi.mock("./deployment-defaults.js", () => ({
  readsAllDeploymentRows: vi.fn(async (ws?: string | null) => !ws || ws === FOUNDING),
}));
/** Workspace GitLab servers: workspace id → host → token. */
let workspaceServers: Record<string, Record<string, string>> = {};
vi.mock("./workspace-gitlab-service.js", async (importActual) => {
  const actual = await importActual<typeof import("./workspace-gitlab-service.js")>();
  return {
    ...actual,
    workspaceGitLabHosts: vi.fn(async (ws?: string | null) =>
      ws ? Object.keys(workspaceServers[ws] ?? {}) : [],
    ),
    workspaceGitLabToken: vi.fn(
      async (ws?: string | null, host?: string | null) =>
        (ws && host && workspaceServers[ws]?.[host]) || null,
    ),
  };
});
const getGitHubToken = vi.fn(async (_opts: unknown) => "gh-token");
vi.mock("./github-token-service.js", () => ({
  getGitHubToken: (opts: unknown) => getGitHubToken(opts),
}));
vi.mock("./codecommit-credential-service.js", () => ({
  getCodeCommitCredentials: vi.fn(async () => "cc"),
}));
vi.mock("./git-platform/index.js", () => ({ createGitPlatform: vi.fn() }));

import { getGitToken, gitLabTokenNameForHost } from "./git-token-service.js";
const all = () => ({
  "GITLAB_TOKEN|user|user-1": "user-token",
  "GITLAB_USER_ACCESS_TOKEN|user:user-1|-": "legacy-user-token",
  "GITLAB_TOKEN|workspace|ws-1": "workspace-token",
  "GITLAB_TOKEN|global|-": "org-token",
});

beforeEach(() => {
  stored = all();
  shared = new Set();
  workspaceServers = {};
  process.env.GITLAB_TOKEN = "env-token";
});
afterEach(() => {
  delete process.env.GITLAB_TOKEN;
});

const gitlab = (ctx: Parameters<typeof getGitToken>[1]) => getGitToken("gitlab", ctx);

describe("GitLab tokens and host precedence", () => {
  it("then the person's own, under GITLAB_TOKEN", async () => {
    expect(await gitlab({ userId: "user-1", workspaceId: "ws-1" })).toBe("user-token");
  });
  it("still honours a personal token saved under the older name", async () => {
    delete stored["GITLAB_TOKEN|user|user-1"];
    expect(await gitlab({ userId: "user-1", workspaceId: "ws-1" })).toBe("legacy-user-token");
  });
  it("then the workspace's, then the organization's", async () => {
    expect(await gitlab({ workspaceId: "ws-1" })).toBe("workspace-token");
    delete stored["GITLAB_TOKEN|workspace|ws-1"];
    expect(await gitlab({ workspaceId: "ws-1" })).toBe("org-token");
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
  it("names a host's token GITLAB_TOKEN_<HOST>", () => {
    expect(gitLabTokenNameForHost("gitlab.com")).toBe("GITLAB_TOKEN_GITLAB_COM");
    expect(gitLabTokenNameForHost("https://git.example.com:8443/")).toBe(
      "GITLAB_TOKEN_GIT_EXAMPLE_COM_8443",
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
    // The workspace's own (even its plain one) comes before any deployment token…
    expect(await gitlab({ server: true, workspaceId: "ws-1", host: "git.corp" })).toBe(
      "workspace-token",
    );
    // …and among the deployment's, the host's comes before the plain one.
    delete stored["GITLAB_TOKEN|workspace|ws-1"];
    expect(await gitlab({ server: true, workspaceId: "ws-1", host: "git.corp" })).toBe(
      "org-corp-token",
    );
  });
});

describe("GitLab host environment", () => {
  it("uses the host-specific environment token", async () => {
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

describe("A workspace's own GitLab servers", () => {
  it("come after the person's own token and before the deployment's", async () => {
    workspaceServers = { "ws-1": { "git.corp": "ws1-corp-token" } };
    expect(await gitlab({ userId: "user-1", workspaceId: "ws-1", host: "git.corp" })).toBe(
      "user-token",
    );
    expect(await gitlab({ server: true, workspaceId: "ws-1", host: "git.corp" })).toBe(
      "ws1-corp-token",
    );
    // The deployment's host token no longer overrides the workspace's own.
    stored["GITLAB_TOKEN_GIT_CORP|global|-"] = "org-corp-token";
    expect(await gitlab({ server: true, workspaceId: "ws-1", host: "git.corp" })).toBe(
      "ws1-corp-token",
    );
  });

  it("serve their own workspace only", async () => {
    workspaceServers = { "ws-2": { "git.corp": "ws2-corp-token" } };
    stored = {};
    delete process.env.GITLAB_TOKEN;
    // ws-3 has no server of its own and isn't the founding workspace.
    await expect(gitlab({ server: true, workspaceId: "ws-3", host: "git.corp" })).rejects.toThrow(
      /in this workspace/,
    );
    // Nor does the founding workspace, or a caller with no workspace, see ws-2's.
    await expect(gitlab({ server: true, workspaceId: "ws-1", host: "git.corp" })).rejects.toThrow();
    await expect(gitlab({ server: true, host: "git.corp" })).rejects.toThrow();
    expect(await gitlab({ server: true, workspaceId: "ws-2", host: "git.corp" })).toBe(
      "ws2-corp-token",
    );
  });

  it("use the workspace's default server when no host is named", async () => {
    workspaceServers = { "ws-2": { "git.corp": "ws2-corp-token" } };
    expect(await gitlab({ server: true, workspaceId: "ws-2" })).toBe("ws2-corp-token");
  });
});

describe("The deployment's GitLab credentials", () => {
  it("serve the founding workspace and callers with no workspace", async () => {
    delete stored["GITLAB_TOKEN|workspace|ws-1"];
    expect(await gitlab({ server: true, workspaceId: "ws-1" })).toBe("org-token");
    expect(await gitlab({ server: true })).toBe("org-token");
  });

  it("are not used by other workspaces unless shared — stored or from the environment", async () => {
    await expect(gitlab({ server: true, workspaceId: "ws-2" })).rejects.toThrow(
      /Workspace Settings → GitLab/,
    );
    stored = {};
    await expect(gitlab({ server: true, workspaceId: "ws-2" })).rejects.toThrow();
    // The environment can't be shared: still the founding workspace's alone.
    expect(await gitlab({ server: true, workspaceId: "ws-1" })).toBe("env-token");
  });

  it("serve every workspace once a deployment admin shares them", async () => {
    shared.add("GITLAB_TOKEN");
    expect(await gitlab({ server: true, workspaceId: "ws-2" })).toBe("org-token");
    // A workspace's own still comes first.
    workspaceServers = { "ws-2": { "gitlab.com": "ws2-token" } };
    expect(await gitlab({ server: true, workspaceId: "ws-2", host: "gitlab.com" })).toBe(
      "ws2-token",
    );
  });
});
