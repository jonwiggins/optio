import { describe, expect, it, vi } from "vitest";
import {
  EXPIRY_MARGIN_MS,
  credentialsExpireSoon,
  freshClaudeCredentials,
  parseClaudeCredentials,
} from "../local/claude-credentials.js";

describe("parseClaudeCredentials", () => {
  it("reads the access token and expiry from what `claude login` writes", () => {
    expect(
      parseClaudeCredentials(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "sk-ant-oat01-abc",
            refreshToken: "sk-ant-ort01-secret",
            expiresAt: 1789900000000,
            scopes: ["user:inference"],
          },
        }),
      ),
    ).toEqual({ accessToken: "sk-ant-oat01-abc", expiresAt: "2026-09-20T10:26:40.000Z" });
  });

  it("returns null for junk or a login without an OAuth token", () => {
    expect(parseClaudeCredentials("not json")).toBeNull();
    expect(parseClaudeCredentials("{}")).toBeNull();
    expect(
      parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "" } })),
    ).toBeNull();
  });

  it("never exposes the refresh token", () => {
    const parsed = parseClaudeCredentials(
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", refreshToken: "r" } }),
    );
    expect(JSON.stringify(parsed)).not.toContain('"r"');
    expect(parsed).toEqual({ accessToken: "sk-ant-oat01-x", expiresAt: null });
  });
});

describe("freshClaudeCredentials", () => {
  const t0 = Date.parse("2026-10-05T12:00:00Z");
  const at = (ms: number) => new Date(t0 + ms).toISOString();

  it("hands over a login that is good for a while without running claude", async () => {
    const renew = vi.fn(async () => null);
    const fresh = await freshClaudeCredentials({
      read: async () => ({ accessToken: "sk-ant-oat01-a", expiresAt: at(3 * 3_600_000) }),
      renew,
      now: () => t0,
    });
    expect(fresh).toEqual({
      creds: { accessToken: "sk-ant-oat01-a", expiresAt: at(3 * 3_600_000) },
      renewed: false,
    });
    expect(renew).not.toHaveBeenCalled();
  });

  it("runs claude once to renew an expired login and reads the new token", async () => {
    let logins = 0;
    const read = async () =>
      logins === 0
        ? { accessToken: "sk-ant-oat01-old", expiresAt: at(-60_000) }
        : { accessToken: "sk-ant-oat01-new", expiresAt: at(8 * 3_600_000) };
    const renew = vi.fn(async () => {
      logins++;
      return null;
    });
    const fresh = await freshClaudeCredentials({ read, renew, now: () => t0 });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(fresh).toEqual({
      creds: { accessToken: "sk-ant-oat01-new", expiresAt: at(8 * 3_600_000) },
      renewed: true,
    });
  });

  it("treats a login about to expire as expired", async () => {
    const renew = vi.fn(async () => null);
    await freshClaudeCredentials({
      read: async () => ({ accessToken: "sk-ant-oat01-a", expiresAt: at(EXPIRY_MARGIN_MS - 1) }),
      renew,
      now: () => t0,
    });
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it("says why when claude could not renew the login", async () => {
    const stale = { accessToken: "sk-ant-oat01-old", expiresAt: at(-60_000) };
    const fresh = await freshClaudeCredentials({
      read: async () => stale,
      renew: async () => "Not logged in",
      now: () => t0,
    });
    expect(fresh.renewed).toBe(true);
    expect(fresh.error).toContain("could not renew it (Not logged in)");
    expect(fresh.error).toContain("sign in again");
  });

  it("reports a machine with no login at all", async () => {
    const renew = vi.fn(async () => null);
    const fresh = await freshClaudeCredentials({ read: async () => null, renew, now: () => t0 });
    expect(fresh.creds).toBeNull();
    expect(fresh.error).toContain("No Claude Code login");
    expect(renew).not.toHaveBeenCalled();
  });

  it("shares one renewal between requests that arrive together", async () => {
    let resolveRenew: (v: string | null) => void = () => {};
    const renew = vi.fn(() => new Promise<string | null>((r) => (resolveRenew = r)));
    const read = async () => ({ accessToken: "sk-ant-oat01-x", expiresAt: at(-1) });
    const a = freshClaudeCredentials({ read, renew, now: () => t0 });
    const b = freshClaudeCredentials({ read, renew, now: () => t0 });
    await vi.waitFor(() => expect(renew).toHaveBeenCalled());
    resolveRenew(null);
    await Promise.all([a, b]);
    expect(renew).toHaveBeenCalledTimes(1);
  });
});

describe("credentialsExpireSoon", () => {
  it("is false without an expiry and true past it", () => {
    expect(credentialsExpireSoon({ accessToken: "x", expiresAt: null })).toBe(false);
    expect(
      credentialsExpireSoon({ accessToken: "x", expiresAt: "2020-01-01T00:00:00Z" }, Date.now()),
    ).toBe(true);
  });
});
