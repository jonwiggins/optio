import { afterEach, describe, expect, it, vi } from "vitest";
import { isSignInHost, linkedAccount, publicEmailTrusted, signInHost } from "./identity.js";

afterEach(() => vi.unstubAllEnvs());

describe("which host is the sign-in authority", () => {
  it("is github.com for GitHub and GITLAB_OAUTH_BASE_URL's host for GitLab", () => {
    vi.stubEnv("GITLAB_OAUTH_BASE_URL", "https://GitLab.Acme.example.test:8443/");
    expect(signInHost("github")).toBe("github.com");
    expect(signInHost("gitlab")).toBe("gitlab.acme.example.test:8443");
    expect(isSignInHost("gitlab", "gitlab.acme.example.test:8443")).toBe(true);
    expect(isSignInHost("gitlab", "gitlab.acme.example.test")).toBe(false);
    vi.stubEnv("GITLAB_OAUTH_BASE_URL", "");
    expect(signInHost("gitlab")).toBe("gitlab.com");
    vi.stubEnv("GITLAB_OAUTH_BASE_URL", "not a url");
    expect(isSignInHost("gitlab", "gitlab.com")).toBe(false);
  });

  it("links an author and trusts a GitLab public email only on the sign-in host", () => {
    vi.stubEnv("GITLAB_OAUTH_BASE_URL", "https://gitlab.example.test");
    expect(linkedAccount("gitlab", "gitlab.example.test", 7)).toEqual({
      provider: "gitlab",
      externalId: "7",
    });
    expect(linkedAccount("gitlab", "other.example.test", 7)).toBeNull();
    expect(linkedAccount("gitlab", "gitlab.example.test", null)).toBeNull();
    expect(publicEmailTrusted("gitlab", "gitlab.example.test")).toBe(true);
    expect(publicEmailTrusted("gitlab", "self-managed.example.test")).toBe(false);
    expect(publicEmailTrusted("github", "github.com")).toBe(true);
  });
});
