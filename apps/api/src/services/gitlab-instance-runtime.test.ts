import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  configureGitLabInstances([]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("glinst defaults", () => {
  it("leaves upstream host detection and native fetch unchanged with no instances", async () => {
    vi.stubEnv("OPTIO_PROFILE", "full");
    configureGitLabInstances([]);
    expect(knownHostPlatform("git.example.com")).toBeNull();
    expect(parseRepoUrl("https://git.example.com/a/b")?.platform).toBe("github");
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const init = { headers: { Authorization: "Bearer old-token" } };
    await gitLabFetch("https://gitlab.com/api/v4/user", init);
    expect(fetch).toHaveBeenCalledWith("https://gitlab.com/api/v4/user", init);
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
  it("preserves the case of an opted-in installation's URL root", () => {
    configureGitLabInstances([
      { baseUrl: "https://git.example.com/GitLab", caPem: null, token: null },
    ]);
    const url = normalizeRepoUrl("https://GIT.EXAMPLE.COM/GitLab/group/project.git");
    expect(url).toBe("https://git.example.com/GitLab/group/project");
    expect(parseRepoUrl(url)?.owner).toBe("group");
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
