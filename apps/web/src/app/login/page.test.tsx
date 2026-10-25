import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const nav = { query: "" };
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
}));

const getAuthProviders = vi.fn();
const ldapLogin = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getAuthProviders: () => getAuthProviders(),
    ldapLogin: (...a: unknown[]) => ldapLogin(...a),
  },
}));

import LoginPage from "./page";

const OIDC = { name: "oidc", displayName: "Corp SSO", method: "redirect" };
const LDAP = {
  name: "ldap",
  displayName: "Corporate account",
  method: "password",
  usernameLabel: "Windows login",
};

beforeEach(() => {
  nav.query = "";
  getAuthProviders.mockReset();
  ldapLogin.mockReset();
});
afterEach(cleanup);

describe("LoginPage", () => {
  it("renders a button for a redirect provider and a form for a password one, with 'or' between", async () => {
    getAuthProviders.mockResolvedValue({ providers: [OIDC, LDAP], authDisabled: false });
    render(<LoginPage />);

    const button = await screen.findByRole("link", { name: /Sign in with Corp SSO/ });
    expect(button).toHaveAttribute("href", "/api/auth/oidc/login");

    const form = screen.getByRole("form", { name: "Sign in with Corporate account" });
    expect(form).toBeInTheDocument();
    expect(screen.getByLabelText("Windows login")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("or")).toBeInTheDocument();
    // Only the providers the API listed.
    expect(screen.queryByText(/Google|GitHub|GitLab/)).toBeNull();
  });

  it("shows GitHub, Google and GitLab with their marks beside SSO and the LDAP form", async () => {
    getAuthProviders.mockResolvedValue({
      providers: [
        { name: "github", displayName: "GitHub", method: "redirect" },
        { name: "google", displayName: "Google", method: "redirect" },
        // An API that doesn't say how a provider signs in: a button, as before.
        { name: "gitlab", displayName: "GitLab" },
        OIDC,
        LDAP,
      ],
      authDisabled: false,
    });
    render(<LoginPage />);

    for (const [label, href] of [
      ["GitHub", "/api/auth/github/login"],
      ["Google", "/api/auth/google/login"],
      ["GitLab", "/api/auth/gitlab/login"],
      ["Corp SSO", "/api/auth/oidc/login"],
    ]) {
      const link = await screen.findByRole("link", { name: `Sign in with ${label}` });
      expect(link).toHaveAttribute("href", href);
      expect(link.querySelector("svg")).not.toBeNull();
    }
    expect(
      screen.getByRole("form", { name: "Sign in with Corporate account" }),
    ).toBeInTheDocument();
  });

  it("shows only the form, labelled Username, when LDAP is the sole provider", async () => {
    getAuthProviders.mockResolvedValue({
      providers: [{ ...LDAP, usernameLabel: null }],
      authDisabled: false,
    });
    render(<LoginPage />);

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Sign in with/ })).toBeNull();
    expect(screen.queryByText("or")).toBeNull();
  });

  it("posts the username and password and shows the API's refusal inline", async () => {
    getAuthProviders.mockResolvedValue({ providers: [LDAP], authDisabled: false });
    ldapLogin.mockRejectedValue(
      Object.assign(new Error("Wrong username or password"), { status: 401 }),
    );
    render(<LoginPage />);

    fireEvent.change(await screen.findByLabelText("Windows login"), {
      target: { value: "  jdoe " },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.submit(screen.getByRole("form", { name: "Sign in with Corporate account" }));

    await waitFor(() =>
      expect(ldapLogin).toHaveBeenCalledWith({ username: "jdoe", password: "hunter2" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong username or password");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("explains the ?error= codes the API redirects with", async () => {
    nav.query = "error=group_not_allowed";
    getAuthProviders.mockResolvedValue({ providers: [OIDC], authDisabled: false });
    render(<LoginPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your account isn't in a group allowed to use Optio",
    );
  });

  it("tells a disabled account so", async () => {
    nav.query = "error=account_disabled";
    getAuthProviders.mockResolvedValue({ providers: [OIDC], authDisabled: false });
    render(<LoginPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your Optio account is disabled. Ask an Optio administrator",
    );
  });

  it("points at the setup wizard when nothing is configured", async () => {
    getAuthProviders.mockResolvedValue({ providers: [], authDisabled: false });
    render(<LoginPage />);
    expect(await screen.findByText("Nobody can sign in yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the setup wizard" })).toHaveAttribute(
      "href",
      "/setup",
    );
    expect(screen.getByText(/configure a sign-in provider/)).toBeInTheDocument();
  });
});

describe("additional enabled sign-in options", () => {
  it("links every enabled redirect provider and omits disabled options", async () => {
    getAuthProviders.mockResolvedValue({
      providers: [
        { name: "bitbucket", displayName: "Bitbucket Cloud", method: "redirect" },
        { name: "gitea", displayName: "Forgejo", method: "redirect" },
        { name: "saml", displayName: "SAML SSO", method: "redirect" },
      ],
      authDisabled: false,
    });
    render(<LoginPage />);
    for (const [provider, label] of [
      ["bitbucket", "Bitbucket Cloud"],
      ["gitea", "Forgejo"],
      ["saml", "SAML SSO"],
    ]) {
      expect(await screen.findByRole("link", { name: `Sign in with ${label}` })).toHaveAttribute(
        "href",
        `/api/auth/${provider}/login`,
      );
    }
    expect(screen.queryByRole("link", { name: /Google|GitHub|GitLab/ })).toBeNull();
  });
});
