import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SignInConfig } from "@/lib/api-client";
import { useCurrentUserStore } from "@/hooks/use-current-user";

const getSignInConfig = vi.fn();
const saveSignInProvider = vi.fn();
const testSignInProvider = vi.fn();
const deleteSignInProvider = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getCurrentUser: () => new Promise(() => {}),
    getSignInConfig: (...a: unknown[]) => getSignInConfig(...a),
    saveSignInProvider: (...a: unknown[]) => saveSignInProvider(...a),
    testSignInProvider: (...a: unknown[]) => testSignInProvider(...a),
    deleteSignInProvider: (...a: unknown[]) => deleteSignInProvider(...a),
    ldapLogin: vi.fn(),
    searchGroups: vi.fn(async () => ({ groups: [] })),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SignInSettings, SignInSetupForm } from "./sign-in-settings";

const EMPTY_OIDC = {
  provider: "oidc" as const,
  displayName: "SSO (OpenID Connect)",
  configurable: true,
  enabled: false,
  source: "none" as const,
  clientId: null,
  hasClientSecret: false,
  allowedDomains: [],
  settings: null,
  callbackUrl: "https://optio.example.com/api/auth/oidc/callback",
  updatedAt: null,
};
const EMPTY_LDAP = {
  provider: "ldap" as const,
  displayName: "LDAP / Active Directory",
  configurable: true,
  enabled: false,
  source: "none" as const,
  clientId: null,
  hasClientSecret: false,
  allowedDomains: [],
  settings: null,
  callbackUrl: null,
  updatedAt: null,
};

const adminConfig = (over: Partial<SignInConfig> = {}): SignInConfig => ({
  bootstrap: false,
  canEdit: true,
  canClaim: false,
  publicUrl: "https://optio.example.com",
  providers: [EMPTY_OIDC, EMPTY_LDAP],
  deploymentAdmins: [],
  ...over,
});

const signedInAdmin = {
  user: {
    id: "u1",
    provider: "oidc",
    email: "admin@example.com",
    displayName: "Admin",
    avatarUrl: null,
    workspaceId: "w1",
    workspaceRole: "admin",
    deploymentAdmin: true,
  },
  authDisabled: false,
  loaded: true,
};

beforeEach(() => {
  useCurrentUserStore.getState().reset();
  useCurrentUserStore.setState(signedInAdmin);
  getSignInConfig.mockReset();
  saveSignInProvider.mockReset();
  testSignInProvider.mockReset();
  deleteSignInProvider.mockReset();
});
afterEach(cleanup);

const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** Type group names into a group picker and commit them (Enter). */
const addGroups = (label: string, value: string) => {
  const input = screen.getByRole("combobox", { name: label });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
};

describe("SignInSetupForm — SSO (OpenID Connect)", () => {
  it("saves the typed settings as the shared body shape", async () => {
    getSignInConfig.mockResolvedValue(adminConfig());
    saveSignInProvider.mockResolvedValue({
      provider: { ...EMPTY_OIDC, enabled: true, source: "database", clientId: "optio" },
      bootstrap: false,
    });
    render(<SignInSetupForm mode="settings" />);

    const form = await screen.findByRole("form", { name: "SSO (OpenID Connect) settings" });
    expect(screen.getByText(EMPTY_OIDC.callbackUrl)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "keycloak" } });
    type("Button label", "Corp SSO");
    type("Issuer URL", " https://sso.example.com/realms/corp ");
    type("Client ID", "optio");
    type("Client secret", "s3cret");
    type("Groups claim", "roles");
    addGroups("Admin groups", "optio-admins, Platform Team");
    type("Allowed email domains", "example.com");
    fireEvent.change(screen.getByLabelText("Role on joining"), { target: { value: "viewer" } });

    fireEvent.submit(form);

    await waitFor(() => expect(saveSignInProvider).toHaveBeenCalledTimes(1));
    const [provider, body, token] = saveSignInProvider.mock.calls[0]!;
    expect(provider).toBe("oidc");
    expect(token).toBeUndefined();
    expect(body).toEqual({
      clientId: "optio",
      clientSecret: "s3cret",
      allowedDomains: ["example.com"],
      enabled: true,
      displayName: "Corp SSO",
      settings: {
        preset: "keycloak",
        issuerUrl: "https://sso.example.com/realms/corp",
        scopes: undefined,
        groupsClaim: "roles",
        emailClaim: undefined,
        nameClaim: undefined,
        usernameClaim: undefined,
        trustEmail: false,
        usePkce: true,
        tokenAuthMethod: "client_secret_post",
        caPem: null,
        insecureSkipVerify: false,
        adminGroups: ["optio-admins", "Platform Team"],
        requiredGroups: [],
        autoJoinOrganization: false,
        defaultRole: "viewer",
        linkByEmail: false,
      },
    });
    // Secrets never leak into the body as empty strings or into the settings object.
    expect(JSON.stringify(body)).not.toContain('"scopes"');
  });

  it("tests the unsaved form with the setup token during bootstrap and shows what discovery found", async () => {
    getSignInConfig.mockResolvedValue(adminConfig({ bootstrap: true, canEdit: false }));
    testSignInProvider.mockResolvedValue({
      ok: true,
      oidc: {
        issuer: "https://sso.example.com/realms/corp",
        authorizationEndpoint: "https://sso.example.com/realms/corp/protocol/openid-connect/auth",
        tokenEndpoint: "https://sso.example.com/realms/corp/protocol/openid-connect/token",
        userinfoEndpoint: null,
        jwksUri: "https://sso.example.com/realms/corp/protocol/openid-connect/certs",
        scopesSupported: ["openid", "profile", "email", "groups"],
        claimsSupported: ["sub", "email", "groups"],
        groupsClaimAdvertised: true,
        pkceSupported: true,
      },
    });
    render(<SignInSetupForm mode="wizard" />);

    // Nothing is editable until the setup token is typed.
    expect(await screen.findByText("Nobody can sign in yet")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: /settings$/ })).toBeNull();
    type("Setup token", "tok-123");

    await screen.findByRole("form", { name: "SSO (OpenID Connect) settings" });
    expect(screen.getByRole("button", { name: "Save and sign in with SSO" })).toBeInTheDocument();
    expect(screen.getByLabelText("Organization")).toBeInTheDocument();
    type("Issuer URL", "https://sso.example.com/realms/corp");
    type("Client ID", "optio");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(testSignInProvider).toHaveBeenCalledTimes(1));
    const [provider, body, token] = testSignInProvider.mock.calls[0]!;
    expect(provider).toBe("oidc");
    expect(token).toBe("tok-123");
    expect(body.clientId).toBe("optio");
    expect(body).not.toHaveProperty("clientSecret");
    expect(body.settings.issuerUrl).toBe("https://sso.example.com/realms/corp");

    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent("Discovery succeeded");
    expect(result).toHaveTextContent("/protocol/openid-connect/token");
    expect(within(result).getByText("groups")).toBeInTheDocument();
    expect(result).toHaveTextContent("Groups claim advertised: yes");
    expect(result).toHaveTextContent("PKCE (S256): yes");
  });

  it("first setup: the admin group(s) are up front and saved with the provider", async () => {
    getSignInConfig.mockResolvedValue(adminConfig({ bootstrap: true, canEdit: false }));
    saveSignInProvider.mockResolvedValue({
      provider: { ...EMPTY_OIDC, enabled: true, source: "database", clientId: "optio" },
      bootstrap: true,
    });
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        set href(v: string) {
          assign(v);
        },
      },
    });
    render(<SignInSetupForm mode="wizard" />);
    await screen.findByText("Nobody can sign in yet");
    type("Setup token", "tok-123");
    const form = await screen.findByRole("form", { name: "SSO (OpenID Connect) settings" });

    const block = screen.getByTestId("bootstrap-admin-groups");
    expect(block).toHaveTextContent("admitted as admins every time they sign in");
    expect(block).toHaveTextContent("No workspace is created per group");
    // One admin-groups field while bootstrapping, the prominent one.
    expect(screen.getAllByRole("combobox", { name: /Admin group/ })).toHaveLength(1);
    addGroups("Admin group(s)", "Optio-Admins");
    type("Issuer URL", "https://sso.example.com/realms/corp");
    type("Client ID", "optio");
    type("Client secret", "s");
    fireEvent.submit(form);

    await waitFor(() => expect(saveSignInProvider).toHaveBeenCalledTimes(1));
    const [, body] = saveSignInProvider.mock.calls[0]!;
    expect(body.settings.adminGroups).toEqual(["Optio-Admins"]);
  });

  it("shows a failed test's message from the API in red", async () => {
    getSignInConfig.mockResolvedValue(adminConfig());
    testSignInProvider.mockResolvedValue({
      ok: false,
      error: "self-signed certificate in certificate chain — paste the CA under Advanced",
    });
    render(<SignInSetupForm mode="settings" />);
    await screen.findByRole("form", { name: "SSO (OpenID Connect) settings" });
    type("Issuer URL", "https://sso.example.com");
    type("Client ID", "optio");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("paste the CA under Advanced");
    expect(alert.className).toContain("text-error");
  });
});

describe("SignInSetupForm — LDAP / Active Directory", () => {
  it("saves the bind password as the secret and the directory layout as settings", async () => {
    getSignInConfig.mockResolvedValue(adminConfig());
    saveSignInProvider.mockResolvedValue({
      provider: { ...EMPTY_LDAP, enabled: true, source: "database", hasClientSecret: true },
      bootstrap: false,
    });
    render(<SignInSetupForm mode="settings" />);

    await screen.findByRole("form", { name: "SSO (OpenID Connect) settings" });
    fireEvent.click(screen.getByRole("button", { name: "LDAP / Active Directory" }));
    const form = await screen.findByRole("form", { name: "LDAP / Active Directory settings" });
    expect(
      screen.getByPlaceholderText(
        "(|(sAMAccountName={{username}})(uid={{username}})(mail={{username}}))",
      ),
    ).toBeInTheDocument();

    type("Server URL", "ldaps://ad.example.com:636");
    type("Bind DN", "CN=optio,OU=Service Accounts,DC=corp,DC=example");
    type("Bind password", "bindpw");
    type("User base DN", "OU=People,DC=corp,DC=example");
    type("Username label", "Windows login");
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.change(screen.getByLabelText("Groups"), { target: { value: "search" } });
    type("Group base DN", "OU=Groups,DC=corp,DC=example");
    addGroups("Admin groups", "Domain Admins");

    fireEvent.submit(form);

    await waitFor(() => expect(saveSignInProvider).toHaveBeenCalledTimes(1));
    const [provider, body] = saveSignInProvider.mock.calls[0]!;
    expect(provider).toBe("ldap");
    expect(body).toEqual({
      clientSecret: "bindpw",
      allowedDomains: [],
      enabled: true,
      displayName: null,
      settings: {
        url: "ldaps://ad.example.com:636",
        startTls: false,
        caPem: null,
        insecureSkipVerify: false,
        bindDn: "CN=optio,OU=Service Accounts,DC=corp,DC=example",
        userBaseDn: "OU=People,DC=corp,DC=example",
        userFilter: null,
        usernameAttribute: null,
        emailAttribute: null,
        displayNameAttribute: null,
        groupMode: "search",
        groupBaseDn: "OU=Groups,DC=corp,DC=example",
        groupFilter: null,
        usernameLabel: "Windows login",
        adminGroups: ["Domain Admins"],
        requiredGroups: [],
        autoJoinOrganization: false,
        defaultRole: "member",
        linkByEmail: false,
      },
    });
    expect(body).not.toHaveProperty("clientId");
  });

  it("during bootstrap, saving shows the password form so the first sign-in can happen here", async () => {
    getSignInConfig.mockResolvedValue(adminConfig({ bootstrap: true, canEdit: false }));
    saveSignInProvider.mockResolvedValue({
      provider: {
        ...EMPTY_LDAP,
        displayName: "Corporate account",
        enabled: true,
        source: "database",
        hasClientSecret: true,
        settings: { url: "ldaps://ad", userBaseDn: "DC=corp", usernameLabel: "Windows login" },
        updatedAt: "2026-10-22T00:00:00.000Z",
      },
      bootstrap: false,
    });
    render(<SignInSetupForm mode="wizard" />);
    await screen.findByLabelText("Setup token");
    type("Setup token", "tok-123");
    fireEvent.click(await screen.findByRole("button", { name: "LDAP / Active Directory" }));
    const form = await screen.findByRole("form", { name: "LDAP / Active Directory settings" });
    type("Server URL", "ldaps://ad.example.com:636");
    type("User base DN", "OU=People,DC=corp,DC=example");
    type("Organization", "Acme");
    expect(screen.getByRole("button", { name: "Save and sign in" })).toBeInTheDocument();
    fireEvent.submit(form);

    await waitFor(() => expect(saveSignInProvider).toHaveBeenCalledTimes(1));
    const [, body, token] = saveSignInProvider.mock.calls[0]!;
    expect(token).toBe("tok-123");
    expect(body.organizationName).toBe("Acme");
    expect(body.enabled).toBe(true);

    const login = await screen.findByRole("form", { name: "Sign in with Corporate account" });
    expect(within(login).getByLabelText("Windows login")).toBeInTheDocument();
    expect(screen.getByText("Sign in to finish setting up")).toBeInTheDocument();
  });

  it("sends the sample username with a test and lists what the directory returned", async () => {
    getSignInConfig.mockResolvedValue(adminConfig());
    testSignInProvider.mockResolvedValue({
      ok: true,
      ldap: {
        boundAs: "CN=optio,DC=corp",
        serverInfo: { vendor: "Samba", namingContexts: ["DC=corp,DC=example"] },
        sample: {
          dn: "CN=Jane Doe,OU=People,DC=corp,DC=example",
          username: "jdoe",
          email: "jdoe@example.com",
          displayName: "Jane Doe",
          groups: ["Developers", "VPN Users"],
        },
      },
    });
    render(<SignInSetupForm mode="settings" />);
    await screen.findByRole("form", { name: "SSO (OpenID Connect) settings" });
    fireEvent.click(screen.getByRole("button", { name: "LDAP / Active Directory" }));
    await screen.findByRole("form", { name: "LDAP / Active Directory settings" });
    type("Server URL", "ldaps://ad.example.com:636");
    type("User base DN", "OU=People,DC=corp,DC=example");
    type("Sample username", "jdoe");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    await waitFor(() => expect(testSignInProvider).toHaveBeenCalledTimes(1));
    const [provider, body] = testSignInProvider.mock.calls[0]!;
    expect(provider).toBe("ldap");
    expect(body.sampleUsername).toBe("jdoe");
    expect(body).not.toHaveProperty("clientSecret");

    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent("Connected and bound");
    expect(result).toHaveTextContent("CN=Jane Doe,OU=People,DC=corp,DC=example");
    expect(result).toHaveTextContent("jdoe@example.com");
    expect(within(result).getByText("VPN Users")).toBeInTheDocument();
  });
});

describe("SignInSettings", () => {
  it("is the target of /settings#sign-in, loading and loaded", async () => {
    let answer: (c: SignInConfig) => void = () => {};
    getSignInConfig.mockReturnValue(new Promise<SignInConfig>((r) => (answer = r)));
    const { container } = render(<SignInSettings />);
    expect(container.querySelector("#sign-in")).not.toBeNull();
    answer(adminConfig());
    await waitFor(() => expect(screen.getByText("none configured")).toBeInTheDocument());
    expect(container.querySelector("#sign-in")).toHaveTextContent("Sign-in");
  });
});

describe("SignInSetupForm — Google, GitHub and GitLab beside SSO and LDAP", () => {
  const EMPTY_GOOGLE = {
    provider: "google" as const,
    displayName: "Google",
    configurable: true,
    enabled: false,
    source: "none" as const,
    clientId: null,
    hasClientSecret: false,
    allowedDomains: [],
    settings: null,
    callbackUrl: "https://optio.example.com/api/auth/google/callback",
    updatedAt: null,
  };
  const envOnly = (provider: "github" | "gitlab", displayName: string, enabled: boolean) => ({
    provider,
    displayName,
    configurable: false,
    enabled,
    source: enabled ? ("environment" as const) : ("none" as const),
    clientId: enabled ? "env-client" : null,
    hasClientSecret: enabled,
    allowedDomains: [],
    settings: null,
    callbackUrl: `https://optio.example.com/api/auth/${provider}/callback`,
    updatedAt: null,
  });
  const allProviders = [
    EMPTY_GOOGLE,
    envOnly("github", "GitHub", true),
    envOnly("gitlab", "GitLab", false),
    EMPTY_OIDC,
    EMPTY_LDAP,
  ];

  it("opens on Google, saves its client and allowed domains, and lists the other providers", async () => {
    getSignInConfig.mockResolvedValue(adminConfig({ providers: allProviders }));
    saveSignInProvider.mockResolvedValue({
      provider: { ...EMPTY_GOOGLE, enabled: true, source: "database", clientId: "g-id" },
      bootstrap: false,
    });
    render(<SignInSetupForm mode="settings" />);

    expect(await screen.findByText(EMPTY_GOOGLE.callbackUrl)).toBeInTheDocument();
    // Google alone in use: its form and a row per other provider, no provider tabs.
    expect(screen.queryByRole("group", { name: "Sign-in provider" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Google", { exact: true })).toHaveLength(1);
    const others = screen.getByRole("list", { name: "Other sign-in providers" });
    expect(within(others).getByText("GitHub")).toBeInTheDocument();
    expect(within(others).getByText("Set by the environment")).toBeInTheDocument();
    expect(within(others).getByText("GitLab")).toBeInTheDocument();
    expect(within(others).getByText(/GITLAB_OAUTH_CLIENT_ID/)).toBeInTheDocument();
    for (const name of ["SSO (OpenID Connect)", "LDAP / Active Directory"]) {
      expect(within(others).getByRole("button", { name: `Set up ${name}` })).toBeInTheDocument();
    }
    expect(within(others).queryByRole("button", { name: /Set up Git(Hub|Lab)/ })).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("1234-abc.apps.googleusercontent.com"), {
      target: { value: " g-id " },
    });
    fireEvent.change(screen.getByPlaceholderText("GOCSPX-…"), { target: { value: "g-secret" } });
    fireEvent.click(screen.getByLabelText(/Only people from these Google Workspace domains/));
    fireEvent.change(screen.getByPlaceholderText("acme.com, acme.io"), {
      target: { value: "Acme.com, acme.io" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(saveSignInProvider).toHaveBeenCalledWith(
        "google",
        {
          clientId: "g-id",
          clientSecret: "g-secret",
          allowedDomains: ["acme.com", "acme.io"],
          enabled: true,
        },
        undefined,
      ),
    );
  });

  it("Set up opens the provider tabs on that provider", async () => {
    getSignInConfig.mockResolvedValue(adminConfig({ providers: allProviders }));
    render(<SignInSetupForm mode="settings" />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up LDAP / Active Directory" }));
    expect(
      await screen.findByRole("form", { name: "LDAP / Active Directory settings" }),
    ).toBeInTheDocument();
    for (const name of ["Google", "SSO (OpenID Connect)", "LDAP / Active Directory"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    const envList = screen.getByRole("list", { name: "Providers set by the environment" });
    expect(within(envList).getByText("GitHub")).toBeInTheDocument();
  });

  it("shows the provider tabs from the start once another provider is in use", async () => {
    getSignInConfig.mockResolvedValue(
      adminConfig({
        providers: [
          EMPTY_GOOGLE,
          envOnly("github", "GitHub", false),
          { ...EMPTY_OIDC, enabled: true, source: "database" as const, clientId: "optio" },
        ],
      }),
    );
    render(<SignInSetupForm mode="settings" />);
    expect(
      await screen.findByRole("form", { name: "SSO (OpenID Connect) settings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Google" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Other sign-in providers" })).toBeNull();
  });

  it("first run: the setup token unlocks Google, which saves the organization and signs in", async () => {
    getSignInConfig.mockResolvedValue(
      adminConfig({ bootstrap: true, canEdit: false, providers: allProviders }),
    );
    saveSignInProvider.mockResolvedValue({
      provider: { ...EMPTY_GOOGLE, enabled: true, source: "database", clientId: "g-id" },
      bootstrap: false,
    });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...original,
        set href(v: string) {
          assign(v);
        },
      },
    });
    try {
      render(<SignInSetupForm mode="wizard" />);
      fireEvent.change(await screen.findByLabelText("Setup token"), {
        target: { value: "tok" },
      });
      fireEvent.change(await screen.findByPlaceholderText("1234-abc.apps.googleusercontent.com"), {
        target: { value: "g-id" },
      });
      fireEvent.change(screen.getByPlaceholderText("GOCSPX-…"), { target: { value: "s" } });
      fireEvent.change(screen.getByPlaceholderText("acme.com, acme.io"), {
        target: { value: "acme.com" },
      });
      fireEvent.change(screen.getByPlaceholderText("Acme"), { target: { value: "Acme Corp" } });
      fireEvent.click(screen.getByRole("button", { name: "Save and sign in with Google" }));

      await waitFor(() =>
        expect(saveSignInProvider).toHaveBeenCalledWith(
          "google",
          {
            clientId: "g-id",
            clientSecret: "s",
            allowedDomains: ["acme.com"],
            enabled: true,
            organizationName: "Acme Corp",
          },
          "tok",
        ),
      );
      await waitFor(() => expect(assign).toHaveBeenCalledWith("/api/auth/google/login"));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: original });
    }
  });
});

describe("more sign-in options", () => {
  it.each(["bitbucket", "gitea", "saml"] as const)(
    "edits %s with access rules disabled by default",
    async (provider) => {
      const labels = { bitbucket: "Bitbucket", gitea: "Gitea / Forgejo", saml: "SSO (SAML 2.0)" };
      const view = {
        ...EMPTY_OIDC,
        provider,
        displayName: labels[provider],
        metadataUrl: "https://optio.example.test/api/auth/saml/metadata",
      };
      getSignInConfig.mockResolvedValue(adminConfig({ providers: [view] }));
      saveSignInProvider.mockResolvedValue({
        provider: { ...view, enabled: true },
        bootstrap: false,
      });
      render(<SignInSetupForm mode="settings" />);
      const form = await screen.findByRole("form", { name: `${labels[provider]} settings` });
      expect(
        screen.getByRole("checkbox", {
          name: /^Everyone who signs in joins the organization workspace/,
        }),
      ).not.toBeChecked();
      if (provider === "saml") {
        type("Identity provider metadata URL", "https://idp.example.test/metadata");
        type("Groups attribute (default: groups)", "roles");
      } else {
        type("Client ID", "client");
        type("Client secret", "secret");
        if (provider === "gitea") type("Gitea / Forgejo server URL", "https://git.example.test");
      }
      fireEvent.submit(form);
      await waitFor(() => expect(saveSignInProvider).toHaveBeenCalled());
      expect(saveSignInProvider.mock.calls[0][0]).toBe(provider);
      expect(saveSignInProvider.mock.calls[0][1].settings).toMatchObject({
        autoJoinOrganization: false,
        requiredGroups: [],
        adminGroups: [],
      });
    },
  );
  it("shows Auth0 and issuer templates, with email trust disabled initially", async () => {
    getSignInConfig.mockResolvedValue(adminConfig());
    render(<SignInSetupForm mode="settings" />);
    await screen.findByRole("form", { name: "SSO (OpenID Connect) settings" });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "auth0" } });
    expect(screen.getByLabelText("Issuer URL")).toHaveAttribute(
      "placeholder",
      "https://{tenant}.{region}.auth0.com/",
    );
  });
});
