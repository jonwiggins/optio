import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getDeploymentSettings: vi.fn(),
  updateDeploymentSettings: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { WorkspaceCreationSettings } from "./workspace-creation-settings";

const settings = (over: Record<string, unknown> = {}) => ({
  workspaceCreation: { value: "admins", source: "environment", environment: "admins" },
  canEdit: true,
  mayCreateWorkspace: true,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceCreationSettings", () => {
  it("is not shown to someone who isn't a deployment admin", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings({ canEdit: false }));
    const { container } = render(<WorkspaceCreationSettings />);
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("follows the deployment until a deployment admin picks, and can go back", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.updateDeploymentSettings.mockResolvedValue(
      settings({ workspaceCreation: { value: "everyone", source: "app", environment: "admins" } }),
    );
    render(<WorkspaceCreationSettings />);
    const follow = await screen.findByRole("button", {
      name: "Follow the deployment (deployment admins only)",
    });
    expect(follow.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Everyone" }));
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenCalledWith({ workspaceCreation: "everyone" }),
    );

    api.updateDeploymentSettings.mockResolvedValue(settings());
    fireEvent.click(
      await screen.findByRole("button", { name: "Follow the deployment (deployment admins only)" }),
    );
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenLastCalledWith({ workspaceCreation: null }),
    );
  });
});
