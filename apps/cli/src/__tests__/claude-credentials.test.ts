import { describe, expect, it } from "vitest";
import { parseClaudeCredentials } from "../local/claude-credentials.js";

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
