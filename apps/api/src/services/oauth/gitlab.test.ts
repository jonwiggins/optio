import { afterEach, describe, expect, it, vi } from "vitest";
import { GitLabOAuthProvider } from "./gitlab.js";

/** GitLab sign-in asks for the API only when the deployment keeps people's tokens. */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const scopeOf = (url: string) => new URL(url).searchParams.get("scope");

describe("GitLabOAuthProvider", () => {
  it("asks for read_user only by default", () => {
    vi.stubEnv("GITLAB_OAUTH_STORE_USER_TOKEN", "");
    expect(scopeOf(new GitLabOAuthProvider().authorizeUrl("s"))).toBe("read_user");
  });

  it("asks for the API too with GITLAB_OAUTH_STORE_USER_TOKEN, and passes the expiry on", async () => {
    vi.stubEnv("GITLAB_OAUTH_STORE_USER_TOKEN", "true");
    expect(scopeOf(new GitLabOAuthProvider().authorizeUrl("s"))).toBe("read_user api");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 7200 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );
    expect(await new GitLabOAuthProvider().exchangeCode("code")).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresIn: 7200,
    });
  });
});
