import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gitLabTokenNameForHost,
  normalizeGitLabHost,
  operatorGitLabHosts,
} from "./workspace-gitlab-service.js";

afterEach(() => vi.unstubAllEnvs());

describe("normalizeGitLabHost", () => {
  it.each([
    ["git.corp.example", "git.corp.example"],
    ["https://Git.Corp.Example/", "git.corp.example"],
    ["HTTP://git.corp.example/group/project?x=1#top", "git.corp.example"],
    ["git.corp.example:8443", "git.corp.example:8443"],
    ["git.corp.example:443", "git.corp.example"],
    ["  gitlab.com  ", "gitlab.com"],
    ["localhost", "localhost"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeGitLabHost(input)).toBe(expected);
  });

  it.each([
    "",
    "user@git.corp.example",
    "git..corp.example",
    "-git.corp.example",
    "git-.corp.example",
    "git.corp.example:0",
    "git.corp.example:65536",
    "git.corp.example:84a3",
    "git.corp.example:1:2",
    "git_corp.example",
    `${"a".repeat(64)}.example`,
  ])("refuses %j", (input) => {
    expect(normalizeGitLabHost(input)).toBeNull();
  });

  it("stays fast on long adversarial input", () => {
    const evil = `${"a.".repeat(50_000)}-!`;
    const started = performance.now();
    expect(normalizeGitLabHost(evil)).toBeNull();
    expect(normalizeGitLabHost(`${"a".repeat(100_000)}:`)).toBeNull();
    expect(gitLabTokenNameForHost(`x${"/".repeat(100_000)}y`)).toMatch(/^GITLAB_TOKEN_X_+Y$/);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("gitLabTokenNameForHost", () => {
  it("upper-cases the host and port, punctuation as underscores", () => {
    expect(gitLabTokenNameForHost("https://git.example.com:8443/")).toBe(
      "GITLAB_TOKEN_GIT_EXAMPLE_COM_8443",
    );
    expect(gitLabTokenNameForHost("gitlab.com")).toBe("GITLAB_TOKEN_GITLAB_COM");
  });
});

describe("operatorGitLabHosts", () => {
  it("is gitlab.com plus the normalized GITLAB_HOSTS / OPTIO_GITLAB_HOSTS, once each", () => {
    vi.stubEnv("GITLAB_HOSTS", "Git.Corp.Example, https://other.example:8443/, not a host");
    vi.stubEnv("OPTIO_GITLAB_HOSTS", "git.corp.example");
    expect(operatorGitLabHosts()).toEqual(["gitlab.com", "git.corp.example", "other.example:8443"]);
  });
});
