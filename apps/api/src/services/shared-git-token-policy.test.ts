import { describe, expect, it } from "vitest";
import {
  SharedGitTokenRefusedError,
  normalizeRepoPattern,
  patternMatches,
  repoKey,
} from "./shared-git-token-policy.js";

describe("normalizeRepoPattern", () => {
  it("keeps host/path, host/path/* and *, lower-cased, without scheme, port or .git", () => {
    expect(normalizeRepoPattern("*")).toBe("*");
    expect(normalizeRepoPattern(" HTTPS://GitLab.Example.com/Team/App.git/ ")).toBe(
      "gitlab.example.com/team/app",
    );
    expect(normalizeRepoPattern("gitlab.example.com:8443/team/*")).toBe(
      "gitlab.example.com/team/*",
    );
    expect(normalizeRepoPattern("gitlab.example.com/*")).toBe("gitlab.example.com/*");
  });

  it("refuses what isn't a repo pattern", () => {
    for (const bad of [
      "",
      "gitlab.example.com",
      "team/*/app",
      "host/a/../b",
      "host/a/./b",
      "host/a%2fb",
      "host/a?x=1",
      "host/a b",
    ]) {
      expect(normalizeRepoPattern(bad), bad).toBeNull();
    }
  });
});

describe("repoKey and patternMatches", () => {
  it("reads https, ssh and credential-bearing URLs alike", () => {
    expect(repoKey("https://gitlab.example.com/Team/App.git")).toBe("gitlab.example.com/team/app");
    expect(repoKey("git@gitlab.example.com:team/app.git")).toBe("gitlab.example.com/team/app");
    expect(repoKey("https://oauth2:secret@gitlab.example.com:8443/team/app")).toBe(
      "gitlab.example.com/team/app",
    );
  });

  it("matches one repo, everything below a group, or everything", () => {
    const url = "https://gitlab.example.com/team/sub/app";
    expect(patternMatches("gitlab.example.com/team/sub/app", url)).toBe(true);
    expect(patternMatches("gitlab.example.com/team/*", url)).toBe(true);
    expect(patternMatches("gitlab.example.com/*", url)).toBe(true);
    expect(patternMatches("*", url)).toBe(true);
    expect(patternMatches("gitlab.example.com/team/sub", url)).toBe(false);
    // A sibling whose name starts the same is not below the group.
    expect(
      patternMatches("gitlab.example.com/team/*", "https://gitlab.example.com/teamx/app"),
    ).toBe(false);
    expect(patternMatches("gitlab.example.com/team/*", "https://other.example.com/team/app")).toBe(
      false,
    );
  });

  it("never matches a URL that may resolve to another repo", () => {
    for (const url of [
      "https://gitlab.example.com/team/../finance/payments",
      "https://gitlab.example.com/team/%2e%2e/finance/payments",
      "https://gitlab.example.com/team/app?x=/finance",
    ]) {
      expect(repoKey(url), url).toBeNull();
      expect(patternMatches("*", url), url).toBe(false);
    }
  });
});

describe("SharedGitTokenRefusedError", () => {
  it("tells the person what to do", () => {
    const err = new SharedGitTokenRefusedError("https://gitlab.example.com/team/app");
    expect(err.message).toContain("GitLab token isn't allowed for https://gitlab.example.com");
    expect(err.message).toContain("private secret named GITLAB_TOKEN");
    expect(err.message).toContain("Settings → Access → Shared git token");
    expect(new SharedGitTokenRefusedError("https://github.com/a/b").message).toContain(
      "GITHUB_TOKEN",
    );
  });
});
