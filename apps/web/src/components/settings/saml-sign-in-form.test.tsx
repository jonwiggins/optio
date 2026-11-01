import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SignInConfig, SignInProviderView } from "@/lib/api-client";
const saveSignInProvider = vi.fn();
const testSignInProvider = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    saveSignInProvider: (...a: unknown[]) => saveSignInProvider(...a),
    testSignInProvider: (...a: unknown[]) => testSignInProvider(...a),
    deleteSignInProvider: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { SamlForm } from "./saml-sign-in-form";
const EMPTY_OIDC: SignInProviderView = {
  provider: "oidc",
  displayName: "SSO (OpenID Connect)",
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
  providers: [EMPTY_OIDC],
});
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => {
  saveSignInProvider.mockReset();
  testSignInProvider.mockReset();
});
afterEach(cleanup);

describe("SAML form extracted from additional sign-in options", () => {
  it("saves the metadata URL and assertion attribute settings", async () => {
    const view: SignInProviderView = {
      ...EMPTY_OIDC,
      provider: "saml",
      displayName: "SSO (SAML 2.0)",
      metadataUrl: "https://optio.example.test/api/auth/saml/metadata",
    };
    saveSignInProvider.mockResolvedValue({
      provider: { ...view, enabled: true },
      bootstrap: false,
    });
    render(
      <SamlForm
        view={view}
        config={adminConfig()}
        setupToken=""
        mode="settings"
        onSaved={vi.fn()}
        onRemoved={vi.fn()}
      />,
    );
    const form = await screen.findByRole("form", { name: "SSO (SAML 2.0) settings" });
    type("Identity provider metadata URL", "https://idp.example.test/metadata");
    type("Groups attribute (default: groups)", "roles");
    const trust = screen.getByRole("checkbox", {
      name: /Trust the identity provider's email addresses/,
    });
    expect(trust).not.toBeChecked();
    fireEvent.click(trust);
    fireEvent.submit(form);
    await waitFor(() => expect(saveSignInProvider).toHaveBeenCalledTimes(1));
    expect(saveSignInProvider.mock.calls[0][0]).toBe("saml");
    expect(saveSignInProvider.mock.calls[0][1].settings).toEqual({
      metadataUrl: "https://idp.example.test/metadata",
      groupsAttribute: "roles",
      trustEmail: true,
      linkByEmail: false,
    });
  });
});
