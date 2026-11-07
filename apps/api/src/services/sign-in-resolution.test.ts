import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { listSignInProviders, resolveProviderConfig } from "./sign-in-config-service.js";

const fixtures = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  failed: false,
  decrypt: vi.fn(),
}));
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async (condition: SQL) => {
          if (fixtures.failed) throw new Error("database unavailable");
          const [provider] = new PgDialect().sqlToQuery(condition).params;
          const row = fixtures.rows.get(String(provider));
          return row ? [row] : [];
        },
      }),
    }),
  },
}));
vi.mock("./secret-service.js", () => ({
  decrypt: (...args: unknown[]) => fixtures.decrypt(...args),
  encrypt: vi.fn(),
}));

const envKeys = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITLAB_OAUTH_CLIENT_ID",
  "GITLAB_OAUTH_CLIENT_SECRET",
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_SCOPES",
  "OIDC_GROUPS_CLAIM",
  "OIDC_EMAIL_CLAIM",
  "OIDC_NAME_CLAIM",
  "OIDC_USERNAME_CLAIM",
  "OIDC_TRUST_EMAIL",
  "OIDC_USE_PKCE",
  "OIDC_CA_PEM",
  "OIDC_LINK_BY_EMAIL",
];
beforeEach(() => {
  fixtures.rows.clear();
  fixtures.failed = false;
  fixtures.decrypt.mockReset();
  fixtures.decrypt.mockReturnValue("decrypted-secret");
  for (const key of envKeys) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());

const environmentCases = [
  {
    provider: "google" as const,
    enabled: "GOOGLE_OAUTH_CLIENT_ID",
    id: "GOOGLE_OAUTH_CLIENT_ID",
    secret: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  {
    provider: "github" as const,
    enabled: "GITHUB_OAUTH_CLIENT_ID",
    id: "GITHUB_OAUTH_CLIENT_ID",
    secret: "GITHUB_OAUTH_CLIENT_SECRET",
  },
  {
    provider: "gitlab" as const,
    enabled: "GITLAB_OAUTH_CLIENT_ID",
    id: "GITLAB_OAUTH_CLIENT_ID",
    secret: "GITLAB_OAUTH_CLIENT_SECRET",
  },
  {
    provider: "oidc" as const,
    enabled: "OIDC_ISSUER_URL",
    id: "OIDC_CLIENT_ID",
    secret: "OIDC_CLIENT_SECRET",
  },
];

describe("sign-in provider configuration precedence", () => {
  it.each(environmentCases)(
    "resolves $provider only when configured and uses environment credentials as a fallback",
    async ({ provider, enabled, id, secret }) => {
      vi.stubEnv(secret, "secret-without-client");
      expect(await resolveProviderConfig(provider)).toBeNull();
      vi.stubEnv(enabled, "https://identity.acme.test");
      vi.stubEnv(id, "client-id");
      vi.stubEnv(secret, "client-secret");
      expect(await resolveProviderConfig(provider)).toEqual({
        clientId: "client-id",
        clientSecret: "client-secret",
        allowedDomains: [],
        source: "environment",
        ...(provider === "oidc"
          ? {
              displayName: "SSO",
              settings: {
                adminGroups: [],
                requiredGroups: [],
                autoJoinOrganization: false,
                issuerUrl: "https://identity.acme.test",
                scopes: "openid email profile",
                groupsClaim: undefined,
                emailClaim: undefined,
                nameClaim: undefined,
                usernameClaim: undefined,
                trustEmail: false,
                usePkce: false,
                caPem: undefined,
                linkByEmail: false,
              },
            }
          : {}),
      });
      vi.stubEnv(secret, undefined);
      expect(await resolveProviderConfig(provider)).toMatchObject({
        clientSecret: "",
        source: "environment",
      });
    },
  );
  it("supports GitHub App credentials without requiring a second OAuth client", async () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "app-id");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "app-secret");
    expect(await resolveProviderConfig("github")).toMatchObject({
      clientId: "app-id",
      clientSecret: "app-secret",
      source: "environment",
    });
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", undefined);
    expect(await resolveProviderConfig("github")).toMatchObject({ clientSecret: "" });
  });
  it("does not invent an OIDC client id from the issuer URL", async () => {
    vi.stubEnv("OIDC_ISSUER_URL", "https://identity.acme.test");
    expect(await resolveProviderConfig("oidc")).toMatchObject({ clientId: "", clientSecret: "" });
  });
  it("reads a stored enabled client before environment credentials and binds decryption to its provider", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "env-id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "env-secret");
    fixtures.rows.set("google", {
      provider: "google",
      enabled: true,
      clientId: "stored-id",
      allowedDomains: ["acme.test"],
      encryptedClientSecret: Buffer.from("ciphertext"),
      clientSecretIv: Buffer.alloc(12),
      clientSecretAuthTag: Buffer.alloc(16),
    });
    expect(await resolveProviderConfig("google")).toEqual({
      clientId: "stored-id",
      clientSecret: "decrypted-secret",
      allowedDomains: ["acme.test"],
      source: "database",
    });
    expect(fixtures.decrypt).toHaveBeenCalledWith(
      expect.anything(),
      Buffer.from("auth_provider|google"),
      "sign-in google client secret",
    );
  });
  it("does not substitute environment secrets into an enabled but incomplete stored configuration", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "env-id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "env-secret");
    fixtures.rows.set("google", {
      provider: "google",
      enabled: true,
      clientId: "stored-id",
      allowedDomains: null,
    });
    expect(await resolveProviderConfig("google")).toEqual({
      clientId: "stored-id",
      clientSecret: "",
      allowedDomains: [],
      source: "database",
    });
    expect(fixtures.decrypt).not.toHaveBeenCalled();
  });
  it("falls back to environment credentials for disabled stored clients or unavailable configuration storage", async () => {
    fixtures.rows.set("google", { provider: "google", enabled: false, clientId: "disabled-id" });
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "env-id");
    expect(await resolveProviderConfig("google")).toMatchObject({
      clientId: "env-id",
      source: "environment",
    });
    fixtures.failed = true;
    expect(await resolveProviderConfig("google")).toMatchObject({
      clientId: "env-id",
      source: "environment",
    });
  });
  it("lists configured and disabled clients without decrypting or returning their secrets", async () => {
    vi.stubEnv("GITHUB_OAUTH_CLIENT_ID", "github-id");
    vi.stubEnv("GITHUB_OAUTH_CLIENT_SECRET", "do-not-leak");
    fixtures.rows.set("google", {
      provider: "google",
      enabled: false,
      clientId: "disabled-id",
      displayName: "Our Google",
      allowedDomains: ["acme.test"],
      encryptedClientSecret: Buffer.from("stored-secret"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const views = await listSignInProviders();
    expect(views.find((p) => p.provider === "google")).toMatchObject({
      enabled: false,
      displayName: "Our Google",
      clientId: "disabled-id",
      source: "database",
      hasClientSecret: true,
    });
    expect(views.find((p) => p.provider === "github")).toMatchObject({
      enabled: true,
      source: "environment",
      clientId: "github-id",
      hasClientSecret: true,
    });
    expect(views.find((p) => p.provider === "gitlab")).toMatchObject({
      enabled: false,
      source: "none",
      hasClientSecret: false,
    });
    expect(JSON.stringify(views)).not.toMatch(/do-not-leak|stored-secret|decrypted-secret/);
    expect(fixtures.decrypt).not.toHaveBeenCalled();
  });
});
