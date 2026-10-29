import { describe, it, expect, afterEach, vi } from "vitest";
import { parseRepoUrl, resolveRepoPlatform } from "./parse-repo-url.js";

describe("explicit CLI repository platform", () => {
  it("parses with the platform the caller knows", () => {
    const guessed = parseRepoUrl("https://git.example.com/group/sub/app");
    expect(guessed!.platform).toBe("github");
    const ri = parseRepoUrl("https://git.example.com/group/sub/app", "gitlab");
    expect(ri).toEqual({
      platform: "gitlab",
      host: "git.example.com",
      owner: "group/sub",
      repo: "app",
      apiBaseUrl: "https://git.example.com/api/v4",
    });
  });
});

describe("resolveRepoPlatform", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("takes a known host's platform over what is recorded", () => {
    expect(resolveRepoPlatform("https://github.com/acme/gitlab-tools", "gitlab")).toBe("github");
    expect(resolveRepoPlatform("https://gitlab.com/acme/app", "github")).toBe("gitlab");
  });

  it("takes the recorded platform for a host nothing names", () => {
    expect(resolveRepoPlatform("https://git.example.com/acme/app", "gitlab")).toBe("gitlab");
    expect(resolveRepoPlatform("https://git.example.com/acme/app", null)).toBe("github");
    expect(resolveRepoPlatform("https://git.example.com/acme/app", "bogus")).toBe("github");
    expect(resolveRepoPlatform("not a url", null)).toBeNull();
  });
});
