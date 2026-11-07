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
import { OidcForm } from "./oidc-sign-in-form";
const CALLBACK_URL = "https://optio.example.com/api/auth/oidc/callback";
const EMPTY_OIDC: SignInProviderView = {
  provider: "oidc",
  displayName: "SSO (OpenID Connect)",
  configurable: true,
  enabled: false,
  source: "none",
  clientId: null,
  hasClientSecret: false,
  allowedDomains: [],
  callbackUrl: CALLBACK_URL,
  updatedAt: null,
};
const adminConfig = (): SignInConfig => ({
  bootstrap: false,
  canEdit: true,
  canClaim: false,
  publicUrl: "https://optio.example.com",
  providers: [EMPTY_OIDC],
});
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => {
  saveSignInProvider.mockReset();
  testSignInProvider.mockReset();
});
afterEach(cleanup);

describe("OpenID Connect form extracted from sign-in settings", () => {
  it("saves the typed settings as the shared body shape", async () => {
    getSignInConfig.mockResolvedValue(adminConfig());
    saveSignInProvider.mockResolvedValue({
      provider: { ...EMPTY_OIDC, enabled: true, source: "database", clientId: "optio" },
      bootstrap: false,
    });
    render(
      <OidcForm
        view={EMPTY_OIDC}
        config={adminConfig()}
        mode="settings"
        setupToken=""
        onSaved={vi.fn()}
        onRemoved={vi.fn()}
      />,
    );

    const form = await screen.findByRole("form", { name: "SSO (OpenID Connect) settings" });
    expect(screen.getByText(CALLBACK_URL)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "keycloak" } });
    type("Button label", "Corp SSO");
    type("Issuer URL", " https://sso.example.com/realms/corp ");
    type("Client ID", "optio");
    type("Client secret", "s3cret");
    type("Groups claim", "roles");
    type("Allowed email domains", "example.com");

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
        linkByEmail: false,
      },
    });
    // Secrets never leak into the body as empty strings or into the settings object.
    expect(JSON.stringify(body)).not.toContain('"scopes"');
  });
});
