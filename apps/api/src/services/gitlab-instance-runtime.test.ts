import { setOutboundDefaults } from "../utils/outbound-url.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIGURE_GITLAB_CA } from "../utils/pod-env.js";
import {
  knownHostPlatform,
  normalizeGitLabBaseUrl,
  normalizeRepoUrl,
  parsePrUrl,
  parseRepoUrl,
} from "@optio/shared";
import {
  configureGitLabInstances,
  gitLabFetch,
  runtimeGitLabInstance,
} from "./gitlab-instance-runtime.js";

let restoreOutbound: () => void;
beforeEach(() => {
  restoreOutbound = setOutboundDefaults({
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: (input, init) => globalThis.fetch(input, init),
  });
});
afterEach(() => {
  restoreOutbound();
  configureGitLabInstances([]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("glinst defaults", () => {
  it("leaves upstream host detection and guarded transport defaults with no instances", async () => {
    vi.stubEnv("OPTIO_PROFILE", "full");
    configureGitLabInstances([]);
    expect(knownHostPlatform("git.example.com")).toBeNull();
    expect(parseRepoUrl("https://git.example.com/a/b")?.platform).toBe("github");
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const init = { headers: { Authorization: "Bearer old-token" } };
    await gitLabFetch("https://gitlab.com/api/v4/user", init);
    expect(fetch).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/user",
      expect.objectContaining({ ...init, redirect: "error", signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps env hosts working with an empty instance list", () => {
    vi.stubEnv("GITLAB_HOSTS", "git.example.com:8443");
    expect(parseRepoUrl("https://git.example.com:8443/a/b")).toMatchObject({
      platform: "gitlab",
      host: "git.example.com:8443",
      apiBaseUrl: "https://git.example.com:8443/api/v4",
    });
  });
});

describe("glinst locations", () => {
  it("normalizes a repo URL the same before and after its instance is registered", () => {
    const typed = "https://GIT.EXAMPLE.COM/GitLab/Group/Project.git";
    const before = normalizeRepoUrl(typed);
    configureGitLabInstances([
      { baseUrl: "https://git.example.com/GitLab", caPem: null, token: null },
    ]);
    expect(normalizeRepoUrl(typed)).toBe(before);
    expect(before).toBe("https://git.example.com/gitlab/group/project");
    configureGitLabInstances([]);
    expect(normalizeRepoUrl(typed)).toBe(before);
  });

  it("resolves a repo stored before registration, keeping the registered root's case for the API", () => {
    const stored = normalizeRepoUrl("https://git.example.com/GitLab/group/sub/project");
    configureGitLabInstances([
      { baseUrl: "https://git.example.com/GitLab", caPem: null, token: "t" },
    ]);
    expect(parseRepoUrl(stored)).toMatchObject({
      platform: "gitlab",
      host: "git.example.com",
      owner: "group/sub",
      repo: "project",
      apiBaseUrl: "https://git.example.com/GitLab/api/v4",
    });
    expect(runtimeGitLabInstance(stored)?.token).toBe("t");
    expect(runtimeGitLabInstance("https://git.example.com/gitlab-other/x")).toBeNull();
  });

  it("sends clones of the lower-cased URL to an upper-case root, and adds nothing otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-glcase-"));
    const run = (base: string) => {
      const config = join(dir, `gitconfig-${base.length}`);
      execFileSync("bash", ["-c", CONFIGURE_GITLAB_CA.join("\n")], {
        env: { ...process.env, OPTIO_GITLAB_BASE_URL: base, GIT_CONFIG_GLOBAL: config },
      });
      return existsSync(config) ? readFileSync(config, "utf8") : "";
    };
    try {
      const upper = run("https://git.example.com/GitLab");
      expect(upper).toContain('[url "https://git.example.com/GitLab/"]');
      expect(upper).toContain("insteadOf = https://git.example.com/gitlab/");
      expect(run("https://git.example.com:8443/gitlab")).not.toContain("insteadOf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("detects an opted-in host, strips its web prefix and preserves nested namespaces", () => {
    configureGitLabInstances([
      { baseUrl: "https://git.example.com:8443/gitlab", caPem: null, token: "x" },
    ]);
    expect(parseRepoUrl("https://git.example.com:8443/gitlab/group/sub/repo.git")).toMatchObject({
      platform: "gitlab",
      host: "git.example.com:8443",
      owner: "group/sub",
      repo: "repo",
      apiBaseUrl: "https://git.example.com:8443/gitlab/api/v4",
    });
    expect(
      parsePrUrl("https://git.example.com:8443/gitlab/group/sub/repo/-/merge_requests/8"),
    ).toMatchObject({
      owner: "group/sub",
      prNumber: 8,
      apiBaseUrl: "https://git.example.com:8443/gitlab/api/v4",
    });
    expect(runtimeGitLabInstance("git.example.com:8443")?.token).toBe("x");
    expect(runtimeGitLabInstance("git.example.com")).toBeNull();
    expect(
      runtimeGitLabInstance("https://git.example.com:8443/gitlab-other/api/v4/user"),
    ).toBeNull();
  });

  it("uses the instance API base for SSH namespaces without stripping a web prefix", () => {
    configureGitLabInstances([
      { baseUrl: "https://git.example.com/gitlab", caPem: null, token: null },
    ]);
    expect(parseRepoUrl("git@git.example.com:group/project.git")).toMatchObject({
      owner: "group",
      repo: "project",
      apiBaseUrl: "https://git.example.com/gitlab/api/v4",
    });
  });

  it("removes detection when an instance is removed", () => {
    configureGitLabInstances([{ baseUrl: "https://git.example.com", caPem: null, token: null }]);
    expect(knownHostPlatform("git.example.com")).toBe("gitlab");
    configureGitLabInstances([]);
    expect(knownHostPlatform("git.example.com")).toBeNull();
  });

  it("normalizes HTTPS locations while rejecting credentials, HTTP, query and fragment", () => {
    expect(normalizeGitLabBaseUrl("https://GIT.EXAMPLE.COM:8443/gitlab/")).toBe(
      "https://git.example.com:8443/gitlab",
    );
    for (const url of [
      "http://git.example.com",
      "https://user:pass@git.example.com",
      "https://git.example.com?x=y",
      "https://git.example.com/#x",
    ])
      expect(() => normalizeGitLabBaseUrl(url)).toThrow();
  });
});
