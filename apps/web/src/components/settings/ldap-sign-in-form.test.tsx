import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SignInConfig, SignInProviderView } from "@/lib/api-client";
const saveSignInProvider = vi.fn();
const testSignInProvider = vi.fn();
const getSignInConfig = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    saveSignInProvider: (...a: unknown[]) => saveSignInProvider(...a),
    testSignInProvider: (...a: unknown[]) => testSignInProvider(...a),
    deleteSignInProvider: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { LdapForm } from "./ldap-sign-in-form";
const EMPTY_LDAP: SignInProviderView = {
  provider: "ldap",
  displayName: "LDAP / Active Directory",
  configurable: true,
  enabled: false,
  source: "none",
  clientId: null,
  hasClientSecret: false,
  allowedDomains: [],
  callbackUrl: "https://optio.example.com/api/auth/oidc/callback",
  updatedAt: null,
};
const adminConfig = (): SignInConfig => ({
  bootstrap: false,
  canEdit: true,
  canClaim: false,
  publicUrl: "https://optio.example.com",
  providers: [EMPTY_LDAP],
});
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => {
  saveSignInProvider.mockReset();
  testSignInProvider.mockReset();
});
afterEach(cleanup);

describe("LDAP form extracted from sign-in settings", () => {
  it("saves the bind password as the secret and the directory layout as settings", async () => {
    getSignInConfig.mockResolvedValue(adminConfig());
    saveSignInProvider.mockResolvedValue({
      provider: { ...EMPTY_LDAP, enabled: true, source: "database", hasClientSecret: true },
      bootstrap: false,
    });
    render(
      <LdapForm
        view={EMPTY_LDAP}
        config={adminConfig()}
        setupToken=""
        mode="settings"
        onSaved={vi.fn()}
        onRemoved={vi.fn()}
        onSignIn={vi.fn()}
      />,
    );

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
        // Off by default: the directory's addresses grant nothing by email.
        trustEmail: false,
        linkByEmail: false,
      },
    });
    expect(body).not.toHaveProperty("clientId");
  });
});
