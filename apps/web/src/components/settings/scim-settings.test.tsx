import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ request }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import { ScimSettings } from "./scim-settings";
afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("SCIM settings", () => {
  it("selects a provider, generates a token once, and revokes it", async () => {
    let enabled = false;
    let signInProvider: string | null = null;
    request.mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") {
        enabled = true;
        return { token: "optio_scim_once" };
      }
      if (opts?.method === "PUT") {
        signInProvider = JSON.parse(String(opts.body)).signInProvider;
        return {};
      }
      if (opts?.method === "DELETE") {
        enabled = false;
        return undefined;
      }
      return {
        enabled,
        signInProvider,
        baseUrl: "https://optio.example.test/api/scim/v2",
        tokens: enabled ? [{ id: "token-1", name: "IdP", prefix: "optio_scim_" }] : [],
      };
    });
    render(<ScimSettings />);
    await screen.findByText(/Base URL:/);
    expect(screen.queryByLabelText("New SCIM bearer token")).toBeNull();
    fireEvent.change(screen.getByLabelText("Sign-in provider for provisioned accounts"), {
      target: { value: "ldap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(signInProvider).toBe("ldap"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Generate token" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate token" }));
    expect(await screen.findByLabelText("New SCIM bearer token")).toHaveValue("optio_scim_once");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss token" }));
    expect(screen.queryByLabelText("New SCIM bearer token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull());
  });

  it("offers the sign-in providers that are set up, and the saved one", async () => {
    request.mockImplementation(async (url: string) =>
      url === "/api/auth/sign-in"
        ? {
            providers: [
              { provider: "google", enabled: false },
              { provider: "ldap", enabled: true },
              { provider: "oidc", enabled: false },
            ],
          }
        : {
            enabled: false,
            signInProvider: "oidc",
            baseUrl: "https://optio.example.test/api/scim/v2",
            tokens: [],
          },
    );
    render(<ScimSettings />);
    await screen.findByText(/Base URL:/);
    const select = screen.getByLabelText("Sign-in provider for provisioned accounts");
    await waitFor(() =>
      expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual([
        "",
        "ldap",
        "oidc",
      ]),
    );
  });
});
