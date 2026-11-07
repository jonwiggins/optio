import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getDeploymentSettings: vi.fn(),
  updateDeploymentSettings: vi.fn(),
  findUserCredentials: vi.fn(),
  revokeUserSession: vi.fn(),
  revokeAllUserSessions: vi.fn(),
  revokeUserApiKey: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { CredentialLifetimeSettings } from "./credential-lifetime-settings";

const none = (min: number, max: number) => ({
  value: null,
  source: "environment",
  environment: null,
  min,
  max,
});
const settings = (over: Record<string, unknown> = {}) => ({
  workspaceCreation: { value: "everyone", source: "environment", environment: "everyone" },
  sessionMaxHours: none(1, 720),
  sessionIdleMinutes: none(5, 10080),
  cliKeyMaxDays: none(1, 3650),
  canEdit: true,
  mayCreateWorkspace: true,
  ...over,
});

const account = {
  user: {
    id: "u-1",
    email: "leaver@example.com",
    displayName: "Leaver",
    provider: "oidc",
    lastLoginAt: "2026-10-01T00:00:00.000Z",
  },
  sessions: [
    {
      id: "s-1",
      createdAt: "2026-10-01T00:00:00.000Z",
      lastSeenAt: null,
      expiresAt: "2026-10-08T00:00:00.000Z",
    },
  ],
  apiKeys: [
    {
      id: "k-1",
      name: "CLI (2026-10-01)",
      prefix: "pfx-1",
      createdAt: "2026-10-01T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("CredentialLifetimeSettings", () => {
  it("is not shown to someone who isn't a deployment admin", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings({ canEdit: false }));
    const { container } = render(<CredentialLifetimeSettings />);
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("saves a limit, refuses one out of range, and goes back to the deployment", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.updateDeploymentSettings.mockResolvedValue(
      settings({ sessionIdleMinutes: { ...none(5, 10080), value: 30, source: "app" } }),
    );
    render(<CredentialLifetimeSettings />);
    const row = within(await screen.findByTestId("limit-sessionIdleMinutes"));
    const input = row.getByLabelText("Idle timeout");
    const save = row.getByRole("button", { name: "Save" });

    fireEvent.change(input, { target: { value: "2" } });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenCalledWith({ sessionIdleMinutes: 30 }),
    );

    api.updateDeploymentSettings.mockResolvedValue(settings());
    fireEvent.click(await row.findByRole("button", { name: "Follow the deployment (none)" }));
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenLastCalledWith({ sessionIdleMinutes: null }),
    );
  });

  it("finds a person and revokes one key or all sessions, after confirming", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.findUserCredentials.mockResolvedValue({ accounts: [account] });
    api.revokeUserApiKey.mockResolvedValue({ ok: true });
    api.revokeAllUserSessions.mockResolvedValue({ revoked: 1 });
    render(<CredentialLifetimeSettings />);

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "leaver@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    const card = within(await screen.findByTestId("user-credentials"));
    expect(card.getByText(/never expires/)).toBeTruthy();

    fireEvent.click(card.getByRole("button", { name: "Revoke CLI (2026-10-01)" }));
    await waitFor(() => expect(api.revokeUserApiKey).toHaveBeenCalledWith("u-1", "k-1"));

    fireEvent.click(card.getByRole("button", { name: "End all sessions" }));
    await waitFor(() => expect(api.revokeAllUserSessions).toHaveBeenCalledWith("u-1"));
    expect(api.revokeUserSession).not.toHaveBeenCalled();
  });

  it("does nothing when the confirmation is declined", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.findUserCredentials.mockResolvedValue({ accounts: [account] });
    render(<CredentialLifetimeSettings />);
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "leaver@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    const card = within(await screen.findByTestId("user-credentials"));
    fireEvent.click(card.getByRole("button", { name: /^End session from/ }));
    expect(api.revokeUserSession).not.toHaveBeenCalled();
  });
});
