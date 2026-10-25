import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accessDecision, domainDecision, envConfig } from "./sign-in-config-service.js";

describe("accessDecision — required groups, then the allowed domains", () => {
  const acme = ["acme.com", "Acme.io"];

  it("allows anyone when neither domains nor groups are set", () => {
    expect(
      accessDecision({ email: "x@gmail.com", emailVerified: false }, { allowedDomains: [] }),
    ).toBe("allowed");
  });

  it("decides domains exactly as domainDecision does, Workspace domain included", () => {
    const cases = [
      { email: "a@ACME.com", emailVerified: true, hostedDomain: "acme.com" },
      { email: "a@acme.com", emailVerified: true, hostedDomain: "evil.com" },
      { email: "a@gmail.com", emailVerified: true },
      { email: "a@acme.com", emailVerified: true },
      { email: "a@acme.com", emailVerified: false },
      { email: "a@acme.com" },
    ];
    for (const profile of cases) {
      expect(accessDecision(profile, { allowedDomains: acme })).toBe(domainDecision(profile, acme));
    }
    expect(
      accessDecision(
        { email: "a@acme.com", emailVerified: true, hostedDomain: "evil.com" },
        { allowedDomains: acme },
      ),
    ).toBe("domain_not_allowed");
  });

  it("requires one of the required groups, case-insensitively, before looking at domains", () => {
    const settings = { requiredGroups: ["Optio-Users", "platform"] };
    expect(
      accessDecision(
        { email: "a@acme.com", emailVerified: true, groups: ["optio-users"] },
        { allowedDomains: acme, settings },
      ),
    ).toBe("allowed");
    expect(
      accessDecision(
        { email: "a@acme.com", emailVerified: true, groups: ["sales"] },
        { allowedDomains: acme, settings },
      ),
    ).toBe("group_not_allowed");
    expect(
      accessDecision(
        { email: "a@acme.com", emailVerified: true },
        { allowedDomains: [], settings },
      ),
    ).toBe("group_not_allowed");
  });

  it("ignores groups for a provider with no group settings (the account providers)", () => {
    expect(
      accessDecision(
        { email: "a@acme.com", emailVerified: true, groups: [] },
        { allowedDomains: acme, settings: undefined },
      ),
    ).toBe("allowed");
  });
});

describe("envConfig — sign-in from the environment", () => {
  const KEYS = [
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
    "OIDC_ADMIN_GROUPS",
    "OIDC_TRUST_EMAIL",
    "OIDC_USE_PKCE",
    "OIDC_AUTO_JOIN_ORGANIZATION",
    "OIDC_LINK_BY_EMAIL",
    "LDAP_URL",
    "LDAP_BIND_DN",
    "LDAP_BIND_PASSWORD",
    "LDAP_USER_BASE_DN",
    "LDAP_GROUP_MODE",
    "LDAP_ADMIN_GROUPS",
    "LDAP_LINK_BY_EMAIL",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is unconfigured without each provider's variables", () => {
    for (const p of ["google", "github", "gitlab", "oidc", "ldap"] as const) {
      expect(envConfig(p)).toBeNull();
    }
  });

  it("reads the account providers' OAuth clients, GitHub's App client too", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "g-id";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "g-secret";
    process.env.GITLAB_OAUTH_CLIENT_ID = "gl-id";
    process.env.GITHUB_APP_CLIENT_ID = "app-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "app-secret";
    expect(envConfig("google")).toEqual({ clientId: "g-id", clientSecret: "g-secret" });
    expect(envConfig("gitlab")).toEqual({ clientId: "gl-id", clientSecret: "" });
    expect(envConfig("github")).toEqual({ clientId: "app-id", clientSecret: "app-secret" });
    process.env.GITHUB_OAUTH_CLIENT_ID = "oauth-id";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "oauth-secret";
    expect(envConfig("github")).toEqual({ clientId: "oauth-id", clientSecret: "oauth-secret" });
  });

  it("keeps the environment's OIDC as it always was unless told otherwise", () => {
    process.env.OIDC_ISSUER_URL = "https://sso.example.com/realms/optio";
    process.env.OIDC_CLIENT_ID = "optio";
    process.env.OIDC_CLIENT_SECRET = "s";
    expect(envConfig("oidc")).toMatchObject({
      clientId: "optio",
      clientSecret: "s",
      displayName: "SSO",
      settings: {
        issuerUrl: "https://sso.example.com/realms/optio",
        scopes: "openid email profile",
        trustEmail: false,
        usePkce: false,
        autoJoinOrganization: false,
        linkByEmail: false,
      },
    });
  });

  it("reads the OIDC_* opt-ins, lists comma-separated and booleans", () => {
    process.env.OIDC_ISSUER_URL = "https://sso.example.com/realms/optio";
    process.env.OIDC_CLIENT_ID = "optio";
    process.env.OIDC_ADMIN_GROUPS = " platform-admins, ops ";
    process.env.OIDC_TRUST_EMAIL = "true";
    process.env.OIDC_USE_PKCE = "yes";
    process.env.OIDC_AUTO_JOIN_ORGANIZATION = "1";
    process.env.OIDC_LINK_BY_EMAIL = "true";
    process.env.OIDC_SCOPES = "openid email";
    expect(envConfig("oidc")).toMatchObject({
      settings: {
        scopes: "openid email",
        adminGroups: ["platform-admins", "ops"],
        trustEmail: true,
        usePkce: true,
        autoJoinOrganization: true,
        linkByEmail: true,
      },
    });
  });

  it("reads the LDAP_* variables, with the bind password as the secret", () => {
    process.env.LDAP_URL = "ldaps://ad.example.com:636";
    process.env.LDAP_BIND_DN = "CN=optio,OU=Service,DC=corp,DC=example";
    process.env.LDAP_BIND_PASSWORD = "bind-pw";
    process.env.LDAP_USER_BASE_DN = "DC=corp,DC=example";
    process.env.LDAP_GROUP_MODE = "search";
    process.env.LDAP_ADMIN_GROUPS = "Domain Admins";
    expect(envConfig("ldap")).toMatchObject({
      clientId: "",
      clientSecret: "bind-pw",
      settings: {
        url: "ldaps://ad.example.com:636",
        bindDn: "CN=optio,OU=Service,DC=corp,DC=example",
        userBaseDn: "DC=corp,DC=example",
        groupMode: "search",
        adminGroups: ["Domain Admins"],
        linkByEmail: false,
      },
    });
    process.env.LDAP_LINK_BY_EMAIL = "true";
    expect(envConfig("ldap")?.settings).toMatchObject({ linkByEmail: true });
  });
});
