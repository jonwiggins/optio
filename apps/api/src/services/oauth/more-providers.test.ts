import { afterEach, describe, expect, it, vi } from "vitest";
import { BitbucketOAuthProvider } from "./bitbucket.js";
import { createGiteaProvider, giteaOidcSettings } from "./gitea.js";
import { effectiveOidcSettings, oidcPresetDefaults } from "./oidc.js";
import { OIDC_PRESETS, OIDC_PRESET_ISSUER_TEMPLATE } from "@optio/shared";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.restoreAllMocks());

describe("additional sign-in providers", () => {
  it("keeps Bitbucket off without configuration", async () => {
    await expect(new BitbucketOAuthProvider(async () => null).prepare()).rejects.toThrow(
      "isn't configured",
    );
  });
  it("uses Bitbucket's code flow, confirmed primary email and workspace groups", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ access_token: "token", refresh_token: "refresh" }))
      .mockResolvedValueOnce(json({ uuid: "{123}", nickname: "alice", display_name: "Alice" }))
      .mockResolvedValueOnce(
        json({ values: [{ email: "alice@example.test", is_primary: true, is_confirmed: true }] }),
      )
      .mockResolvedValueOnce(json({ values: [{ workspace: { slug: "developers" } }] }));
    const p = new BitbucketOAuthProvider(async () => ({
      clientId: "client",
      clientSecret: "secret",
    }));
    await p.prepare();
    expect(new URL(p.authorizeUrl("state")).searchParams.get("state")).toBe("state");
    expect(await p.exchangeCode("code")).toMatchObject({ accessToken: "token" });
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("client:secret").toString("base64")}`,
    });
    expect(await p.fetchUser("token")).toMatchObject({
      externalId: "{123}",
      emailVerified: true,
      groups: ["developers"],
    });
  });
  it("never treats an unconfirmed Bitbucket address as verified", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ uuid: "123" }))
      .mockResolvedValueOnce(
        json({ values: [{ email: "alice@example.test", is_primary: true, is_confirmed: false }] }),
      )
      .mockResolvedValueOnce(json({}, 403));
    expect((await new BitbucketOAuthProvider().fetchUser("token")).emailVerified).toBe(false);
  });
  it("reports Bitbucket token failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "invalid_grant" }, 400));
    const p = new BitbucketOAuthProvider(async () => ({
      clientId: "client",
      clientSecret: "secret",
    }));
    await expect(p.exchangeCode("bad")).rejects.toThrow("invalid_grant");
  });
  it("uses discovery, PKCE and nonce on a Gitea or Forgejo server including a URL prefix", async () => {
    const issuer = "https://git.example.test/code";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        issuer,
        authorization_endpoint: `${issuer}/login/oauth/authorize`,
        token_endpoint: `${issuer}/login/oauth/access_token`,
        jwks_uri: `${issuer}/login/oauth/keys`,
      }),
    );
    const p = createGiteaProvider(async () => ({
      clientId: "client",
      clientSecret: "secret",
      settings: giteaOidcSettings({ baseUrl: issuer }),
      sendNonce: true,
      source: "environment",
    }));
    const flow = p.beginFlow();
    await p.prepare();
    const url = new URL(p.authorizeUrl("state", flow));
    expect(url.pathname).toBe("/code/login/oauth/authorize");
    expect(url.searchParams.get("nonce")).toBe(flow.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/auth\/gitea\/callback$/);
    expect(giteaOidcSettings({ baseUrl: issuer }).trustEmail).toBe(false);
  });
  it.each(OIDC_PRESETS)("has issuer guidance and group defaults for %s", (preset) => {
    expect(OIDC_PRESET_ISSUER_TEMPLATE[preset]).toMatch(/^https:\/\//);
    expect(oidcPresetDefaults(preset).groupsClaim).toBeTruthy();
    expect(
      effectiveOidcSettings({ issuerUrl: "https://sso.example.test", preset }).trustEmail,
    ).toBe(false);
  });
});
