import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const getAuthProviders = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getAuthProviders: () => getAuthProviders() },
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

import LoginPage from "./page";

afterEach(cleanup);

describe("login page", () => {
  it("starts a redirect sign-in on the web server's own path, not under /api", async () => {
    // An ingress that sends /api straight to the API would otherwise skip the
    // web server that creates the browser verifier (issue #770).
    getAuthProviders.mockResolvedValue({
      providers: [{ name: "oidc", displayName: "SSO", method: "redirect" }],
      authDisabled: false,
      setupRequired: false,
    });
    render(<LoginPage />);
    const link = await screen.findByRole("link", { name: /Sign in with SSO/ });
    expect(link.getAttribute("href")).toBe("/auth/login/oidc");
  });
});
