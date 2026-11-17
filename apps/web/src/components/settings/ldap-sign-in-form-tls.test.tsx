import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SignInConfig, SignInProviderView } from "@/lib/api-client";
const saveSignInProvider = vi.fn();
const testSignInProvider = vi.fn();
const toastError = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    saveSignInProvider: (...a: unknown[]) => saveSignInProvider(...a),
    testSignInProvider: (...a: unknown[]) => testSignInProvider(...a),
    deleteSignInProvider: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}));
import { LdapForm } from "./ldap-sign-in-form";

const STORED_PLAIN: SignInProviderView = {
  provider: "ldap",
  displayName: "LDAP / Active Directory",
  configurable: true,
  enabled: true,
  source: "database",
  clientId: null,
  hasClientSecret: true,
  allowedDomains: [],
  callbackUrl: null,
  updatedAt: null,
  settings: { url: "ldap://ad.example.com:389", userBaseDn: "DC=example,DC=com" },
};
const config = (ldapRequireTls: boolean): SignInConfig => ({
  bootstrap: false,
  canEdit: true,
  canClaim: false,
  publicUrl: "https://optio.example.com",
  ldapRequireTls,
  providers: [STORED_PLAIN],
});
const renderForm = (requireTls: boolean) =>
  render(
    <LdapForm
      view={STORED_PLAIN}
      config={config(requireTls)}
      setupToken=""
      mode="settings"
      onSaved={vi.fn()}
      onRemoved={vi.fn()}
      onSignIn={vi.fn()}
    />,
  );
beforeEach(() => {
  saveSignInProvider.mockReset();
  testSignInProvider.mockReset();
  toastError.mockReset();
});
afterEach(cleanup);

describe("LDAP form when the deployment requires TLS", () => {
  it("says so and refuses to save a plain ldap:// directory", async () => {
    renderForm(true);
    expect(screen.getByText(/This deployment requires TLS:/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /use an ldaps:\/\/ URL or turn on STARTTLS/,
    );
    expect(screen.getByLabelText("Server URL")).toHaveAttribute("aria-invalid", "true");

    fireEvent.submit(screen.getByRole("form", { name: "LDAP / Active Directory settings" }));
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/requires TLS for LDAP/));
    expect(saveSignInProvider).not.toHaveBeenCalled();
  });

  it("clears the warning once STARTTLS is on", () => {
    renderForm(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /^STARTTLS/ }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the plain-LDAP hint and no refusal while the setting is off", () => {
    renderForm(false);
    expect(screen.getByText(/sends passwords in the clear/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
