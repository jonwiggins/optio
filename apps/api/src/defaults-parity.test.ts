/**
 * With nothing set, Optio behaves as upstream does. Every opt-in Optio adds
 * appends a describe block here: its setting unset, upstream's behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_CONNECTION_PROVIDERS,
  ALL_GIT_PLATFORMS,
  ALL_RUNTIMES,
  ALL_TICKET_SOURCES,
  ALL_TRIGGERS,
  agentPolicyDefaultsOn,
  classifyError,
  currentFeatures,
  gitlabOnlyDeployment,
  isMergeRequest,
  offeredModelProviderKinds,
  parseRepoUrl,
  resolveAgentPolicy,
} from "@optio/shared";
import { receiverFor } from "./services/feature-guard.js";
import { mcpServersPreinstalled } from "./services/mcp-preinstalled.js";
import { gitBotEnv, gitBotIdentity } from "./utils/pod-env.js";
import { envConfig } from "./services/sign-in-config-service.js";
import { linkAccountsByEmailEnabled } from "./services/session-service.js";
import { effectiveOidcSettings } from "./services/oauth/oidc.js";

afterEach(() => vi.unstubAllEnvs());

describe("features", () => {
  const SETTINGS = [
    "OPTIO_RUNTIMES",
    "OPTIO_GIT_PLATFORMS",
    "OPTIO_TRIGGERS",
    "OPTIO_TICKET_SOURCES",
    "OPTIO_CONNECTION_PROVIDERS",
    "OPTIO_FEATURE_PRESET",
    "OPTIO_MODEL_ACCESS",
    "OPTIO_AGENT_POLICY_DEFAULTS",
    "OPTIO_MCP_PREINSTALLED",
    "GIT_BOT_NAME",
    "GIT_BOT_EMAIL",
    "GITLAB_HOSTS",
    "OPTIO_GITLAB_HOSTS",
  ];

  beforeEach(() => {
    for (const name of SETTINGS) vi.stubEnv(name, "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers every runtime, git platform, trigger, ticket source and connection provider", () => {
    const f = currentFeatures();
    expect(f.runtimes).toEqual([...ALL_RUNTIMES]);
    expect(f.gitPlatforms).toEqual([...ALL_GIT_PLATFORMS]);
    expect(f.triggers).toEqual([...ALL_TRIGGERS]);
    expect(f.ticketSources).toEqual([...ALL_TICKET_SOURCES]);
    expect(f.connectionProviders).toEqual([...ALL_CONNECTION_PROVIDERS]);
    expect([
      f.runtimes.length,
      f.gitPlatforms.length,
      f.triggers.length,
      f.ticketSources.length,
      f.connectionProviders.length,
    ]).toEqual([7, 3, 14, 5, 12]);
  });

  it("registers every trigger receiver", () => {
    for (const trigger of ALL_TRIGGERS) {
      const app = { post: vi.fn() };
      expect(receiverFor(app, trigger)).toBe(app);
    }
  });

  it("reaches models any way: every model provider kind, upstream's failure messages", () => {
    expect(currentFeatures().modelAccess).toBe("any");
    expect(offeredModelProviderKinds()).toEqual(["bedrock", "gateway"]);
    // Upstream's advice for an expired token, not a gateway deployment's.
    const message = "OAuth token has expired";
    expect(classifyError(message).title).toBe("Authentication token expired");
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    expect(classifyError(message).title).not.toBe("Authentication token expired");
  });

  it("adds no built-in deny rules", () => {
    expect(agentPolicyDefaultsOn()).toBe(false);
    const policy = resolveAgentPolicy({});
    expect(policy.defaults).toBe(false);
    expect(policy.rules).toEqual([]);
  });

  it("treats an unknown git host as GitHub and an unknown change request as a PR", () => {
    expect(gitlabOnlyDeployment()).toBe(false);
    expect(parseRepoUrl("https://git.example.com/team/repo")?.platform).toBe("github");
    expect(isMergeRequest(null)).toBe(false);
  });

  it("commits as upstream's identity chain and adds no bot env", () => {
    expect(gitBotIdentity()).toEqual({
      name: "${GIT_BOT_NAME:-${GITHUB_APP_BOT_NAME:-Optio Agent}}",
      email: "${GIT_BOT_EMAIL:-${GITHUB_APP_BOT_EMAIL:-optio-agent@noreply.github.com}}",
    });
    expect(gitBotEnv()).toEqual({});
  });

  it("starts the built-in MCP servers through npx", () => {
    expect(mcpServersPreinstalled()).toBe(false);
  });
});

describe("signin2", () => {
  it("keeps additional providers disabled without credentials", () => {
    for (const key of [
      "BITBUCKET_OAUTH_CLIENT_ID",
      "GITEA_OAUTH_CLIENT_ID",
      "GITEA_OAUTH_BASE_URL",
      "LDAP_URL",
      "SAML_METADATA_URL",
      "SAML_METADATA_XML",
      "SAML_ENTRY_POINT",
      "OIDC_ISSUER_URL",
    ])
      vi.stubEnv(key, "");
    for (const provider of ["bitbucket", "gitea", "ldap", "oidc", "saml"] as const)
      expect(envConfig(provider)).toBeNull();
    expect(linkAccountsByEmailEnabled({})).toBe(false);
    expect(linkAccountsByEmailEnabled({ OPTIO_LINK_ACCOUNTS_BY_EMAIL: "true" })).toBe(true);
  });
  it("keeps email trust and joining off, while app-configured OIDC retains PKCE", () => {
    vi.stubEnv("OIDC_ISSUER_URL", "https://sso.example.test");
    for (const key of ["OIDC_TRUST_EMAIL", "OIDC_USE_PKCE", "OIDC_AUTO_JOIN_ORGANIZATION"])
      vi.stubEnv(key, "");
    expect(envConfig("oidc")?.settings).toMatchObject({
      trustEmail: false,
      usePkce: false,
      autoJoinOrganization: false,
    });
    expect(effectiveOidcSettings({ issuerUrl: "https://sso.example.test" })).toMatchObject({
      trustEmail: false,
      usePkce: true,
    });
    vi.stubEnv("OIDC_TRUST_EMAIL", "true");
    vi.stubEnv("OIDC_AUTO_JOIN_ORGANIZATION", "true");
    vi.stubEnv("OIDC_USE_PKCE", "true");
    expect(envConfig("oidc")?.settings).toMatchObject({
      trustEmail: true,
      usePkce: true,
      autoJoinOrganization: true,
    });
  });
  it("enables each option only through its own settings", () => {
    vi.stubEnv("BITBUCKET_OAUTH_CLIENT_ID", "client");
    expect(envConfig("bitbucket")?.clientId).toBe("client");
    vi.stubEnv("GITEA_OAUTH_BASE_URL", "https://git.example.test");
    vi.stubEnv("GITEA_OAUTH_CLIENT_ID", "client");
    expect(envConfig("gitea")?.settings).toMatchObject({ baseUrl: "https://git.example.test" });
    vi.stubEnv("SAML_ENTRY_POINT", "https://idp.example.test/sso");
    expect(envConfig("saml")?.settings).toMatchObject({
      entryPoint: "https://idp.example.test/sso",
      autoJoinOrganization: false,
    });
  });
});
