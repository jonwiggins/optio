import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseRepoUrl, parsePrUrl } from "./parse-repo-url.js";

describe("parseRepoUrl", () => {
  it("parses GitHub HTTPS URL", () => {
    const result = parseRepoUrl("https://github.com/owner/repo");
    expect(result).toEqual({
      platform: "github",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("parses GitHub HTTPS URL with .git suffix", () => {
    const result = parseRepoUrl("https://github.com/owner/repo.git");
    expect(result).toEqual({
      platform: "github",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("parses GitHub SSH shorthand", () => {
    const result = parseRepoUrl("git@github.com:owner/repo.git");
    expect(result).toEqual({
      platform: "github",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("parses GitHub SSH protocol", () => {
    const result = parseRepoUrl("ssh://git@github.com/owner/repo.git");
    expect(result).toEqual({
      platform: "github",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("parses GitHub SSH with port", () => {
    const result = parseRepoUrl("ssh://git@github.com:22/owner/repo");
    expect(result).toEqual({
      platform: "github",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("parses bare domain URL", () => {
    const result = parseRepoUrl("github.com/owner/repo");
    expect(result).toEqual({
      platform: "github",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("handles trailing slashes", () => {
    const result = parseRepoUrl("https://github.com/owner/repo/");
    expect(result).toEqual({
      platform: "github",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    });
  });

  it("lowercases host", () => {
    const result = parseRepoUrl("https://GitHub.COM/Owner/Repo");
    expect(result).not.toBeNull();
    expect(result!.host).toBe("github.com");
    expect(result!.platform).toBe("github");
  });

  it("parses GitLab HTTPS URL", () => {
    const result = parseRepoUrl("https://gitlab.com/owner/repo");
    expect(result).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://gitlab.com/api/v4",
    });
  });

  it("parses GitLab SSH shorthand", () => {
    const result = parseRepoUrl("git@gitlab.com:owner/repo.git");
    expect(result).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://gitlab.com/api/v4",
    });
  });

  it("detects self-hosted GitLab by hostname containing 'gitlab'", () => {
    const result = parseRepoUrl("https://gitlab.mycompany.com/team/project");
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("gitlab");
    expect(result!.host).toBe("gitlab.mycompany.com");
    expect(result!.apiBaseUrl).toBe("https://gitlab.mycompany.com/api/v4");
  });

  describe("GITLAB_HOSTS env var", () => {
    const originalEnv = process.env.GITLAB_HOSTS;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.GITLAB_HOSTS;
      } else {
        process.env.GITLAB_HOSTS = originalEnv;
      }
    });

    it("detects self-hosted GitLab from GITLAB_HOSTS", () => {
      process.env.GITLAB_HOSTS = "git.internal.co,code.example.org";
      const result = parseRepoUrl("https://git.internal.co/team/project");
      expect(result).not.toBeNull();
      expect(result!.platform).toBe("gitlab");
    });
  });

  it("defaults unknown hosts to github", () => {
    const result = parseRepoUrl("https://unknown-host.example.com/owner/repo");
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("github");
  });

  it("parses GitLab subgroup repo URL", () => {
    const result = parseRepoUrl("https://gitlab.com/group/subgroup/repo");
    expect(result).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      owner: "group/subgroup",
      repo: "repo",
      apiBaseUrl: "https://gitlab.com/api/v4",
    });
  });

  it("parses GitLab deeply nested subgroup repo URL", () => {
    const result = parseRepoUrl("https://gitlab.com/org/team/sub/project");
    expect(result).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      owner: "org/team/sub",
      repo: "project",
      apiBaseUrl: "https://gitlab.com/api/v4",
    });
  });

  it("GitLab subgroup parseRepoUrl and parsePrUrl owners match", () => {
    const repoResult = parseRepoUrl("https://gitlab.com/group/subgroup/repo");
    const prResult = parsePrUrl("https://gitlab.com/group/subgroup/repo/-/merge_requests/42");
    expect(repoResult).not.toBeNull();
    expect(prResult).not.toBeNull();
    expect(repoResult!.owner).toBe(prResult!.owner);
    expect(repoResult!.repo).toBe(prResult!.repo);
  });

  it("parses CodeCommit HTTPS URL", () => {
    const result = parseRepoUrl("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo");
    expect(result).toEqual({
      platform: "codecommit",
      host: "git-codecommit.us-east-1.amazonaws.com",
      owner: "us-east-1",
      repo: "MyRepo",
      apiBaseUrl: "us-east-1",
    });
  });

  it("parses CodeCommit HTTPS URL with .git suffix", () => {
    const result = parseRepoUrl(
      "https://git-codecommit.eu-west-2.amazonaws.com/v1/repos/MyRepo.git",
    );
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("codecommit");
    expect(result!.owner).toBe("eu-west-2");
    expect(result!.repo).toBe("MyRepo");
    expect(result!.apiBaseUrl).toBe("eu-west-2");
  });

  it("parses CodeCommit SSH URL", () => {
    // CodeCommit SSH URLs use the SSH key ID as the username
    const result = parseRepoUrl(
      "ssh://APKAEIBAERJR2EXAMPLE@git-codecommit.us-west-2.amazonaws.com/v1/repos/AnotherRepo",
    );
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("codecommit");
    expect(result!.owner).toBe("us-west-2");
    expect(result!.repo).toBe("AnotherRepo");
  });

  it("returns null for invalid URLs", () => {
    expect(parseRepoUrl("not-a-url")).toBeNull();
    expect(parseRepoUrl("https://github.com")).toBeNull();
    expect(parseRepoUrl("")).toBeNull();
  });

  it("handles HTTP URL", () => {
    const result = parseRepoUrl("http://github.com/owner/repo");
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("github");
  });

  it("handles whitespace", () => {
    const result = parseRepoUrl("  https://github.com/owner/repo  ");
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("owner");
  });

  it("handles URLs with deeper path segments", () => {
    const result = parseRepoUrl("https://github.com/owner/repo/tree/main/src");
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("owner");
    expect(result!.repo).toBe("repo");
  });
});

describe("parsePrUrl", () => {
  it("parses GitHub PR URL", () => {
    const result = parsePrUrl("https://github.com/owner/repo/pull/42");
    expect(result).toEqual({
      platform: "github",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
      prNumber: 42,
    });
  });

  it("parses GitLab MR URL with /-/ prefix", () => {
    const result = parsePrUrl("https://gitlab.com/owner/repo/-/merge_requests/123");
    expect(result).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://gitlab.com/api/v4",
      prNumber: 123,
    });
  });

  it("parses GitLab MR URL without /-/ prefix", () => {
    const result = parsePrUrl("https://gitlab.com/owner/repo/merge_requests/123");
    expect(result).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://gitlab.com/api/v4",
      prNumber: 123,
    });
  });

  it("parses GitLab subgroup MR URL", () => {
    const result = parsePrUrl("https://gitlab.com/group/subgroup/repo/-/merge_requests/99");
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("group/subgroup");
    expect(result!.repo).toBe("repo");
    expect(result!.prNumber).toBe(99);
  });

  it("parses self-hosted GitLab MR URL", () => {
    const result = parsePrUrl("https://gitlab.myco.com/team/project/-/merge_requests/7");
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("gitlab");
    expect(result!.host).toBe("gitlab.myco.com");
    expect(result!.prNumber).toBe(7);
  });

  it("returns null for non-PR URLs", () => {
    expect(parsePrUrl("https://github.com/owner/repo")).toBeNull();
    expect(parsePrUrl("https://gitlab.com/owner/repo")).toBeNull();
    expect(parsePrUrl("not-a-url")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parsePrUrl("")).toBeNull();
  });
});
