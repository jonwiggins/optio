import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGitHubToken, parseGitHubExpiry, setCredentialHealthFetchForTests } from "./checks.js";

/** Credential health: a GitHub token, asked with `GET /user` (checks.ts). */

const now = new Date("2026-10-25T12:00:00Z");
const API = "https://api.github.com";

function answer(status: number, headers: Record<string, string> = {}, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => setCredentialHealthFetchForTests(null));

describe("parseGitHubExpiry", () => {
  it("reads GitHub's UTC and offset forms", () => {
    expect(parseGitHubExpiry("2026-11-01 12:00:00 UTC")?.toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    );
    expect(parseGitHubExpiry("2026-11-01 14:00:00 +0200")?.toISOString()).toBe(
      "2026-11-01T12:00:00.000Z",
    );
    expect(parseGitHubExpiry(null)).toBeNull();
    expect(parseGitHubExpiry("soon")).toBeNull();
  });
});

describe("checkGitHubToken", () => {
  it("is ok for a token without an expiry, with its account", async () => {
    const f = vi.fn().mockResolvedValue(answer(200, {}, { login: "svc-bot" }));
    setCredentialHealthFetchForTests(f);
    const out = await checkGitHubToken({ token: "ghp_x", apiBaseUrls: [API] }, now);
    expect(out).toMatchObject({ status: "ok", expiresAt: null, details: { account: "svc-bot" } });
    expect(f.mock.calls[0][0]).toBe(`${API}/user`);
    expect(f.mock.calls[0][1].headers.Authorization).toBe("Bearer ghp_x");
  });

  it("warns ahead of the expiry and when a classic token lacks repo", async () => {
    setCredentialHealthFetchForTests(
      vi.fn().mockResolvedValue(
        answer(200, {
          "github-authentication-token-expiration": "2026-10-28 12:00:00 UTC",
          "x-oauth-scopes": "read:org, gist",
        }),
      ),
    );
    const out = await checkGitHubToken({ token: "ghp_x", apiBaseUrls: [API] }, now);
    expect(out.status).toBe("warning");
    expect(out.expiresAt?.toISOString()).toBe("2026-10-28T12:00:00.000Z");
    expect(out.reason).toMatch(/Expires in 3 days/);
    expect(out.reason).toMatch(/lacks the repo scope/);
  });

  it("is an error GitHub refused (401)", async () => {
    setCredentialHealthFetchForTests(vi.fn().mockResolvedValue(answer(401)));
    const out = await checkGitHubToken({ token: "ghp_x", apiBaseUrls: [API] }, now);
    expect(out).toMatchObject({ status: "error", invalid: true });
  });

  it("is unknown when GitHub can't be reached or there is nowhere to ask", async () => {
    setCredentialHealthFetchForTests(vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    expect((await checkGitHubToken({ token: "x", apiBaseUrls: [API] }, now)).status).toBe(
      "unknown",
    );
    expect((await checkGitHubToken({ token: "x", apiBaseUrls: [] }, now)).status).toBe("unknown");
  });

  it("tries the next GitHub when the first refuses it", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(answer(401))
      .mockResolvedValueOnce(answer(200, {}, { login: "me" }));
    setCredentialHealthFetchForTests(f);
    const out = await checkGitHubToken(
      { token: "x", apiBaseUrls: [API, "https://ghe.example.test/api/v3"] },
      now,
    );
    expect(out.status).toBe("ok");
    expect(f.mock.calls[1][0]).toBe("https://ghe.example.test/api/v3/user");
    expect(out.details.host).toBe("ghe.example.test");
  });
});
