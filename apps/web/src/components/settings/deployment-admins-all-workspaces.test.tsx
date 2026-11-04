import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getDeploymentSettings: vi.fn(),
  updateDeploymentSettings: vi.fn(),
  listDeploymentAdmins: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { DeploymentAdminsAllWorkspaces } from "./deployment-admins-all-workspaces";

const off = { value: false, source: "environment", environment: false };
const settings = (over: Record<string, unknown> = {}) => ({
  workspaceCreation: { value: "everyone", source: "environment", environment: "everyone" },
  deploymentAdminsAllWorkspaces: off,
  canEdit: true,
  mayCreateWorkspace: true,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DeploymentAdminsAllWorkspaces", () => {
  it("is not shown to someone who isn't a deployment admin", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings({ canEdit: false }));
    const { container } = render(<DeploymentAdminsAllWorkspaces />);
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    expect(api.listDeploymentAdmins).not.toHaveBeenCalled();
  });

  it("follows Helm's default, turns on in the app, and can follow the deployment again", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.listDeploymentAdmins.mockResolvedValue({
      admins: [
        { id: "u1", email: "ops@acme.io", displayName: "Ops Lead", fromEnvironment: true },
        { id: "u2", email: "sre@acme.io", displayName: "", fromEnvironment: false },
      ],
    });
    api.updateDeploymentSettings.mockResolvedValue(
      settings({ deploymentAdminsAllWorkspaces: { ...off, value: true, source: "app" } }),
    );
    render(<DeploymentAdminsAllWorkspaces />);

    const follow = await screen.findByRole("button", { name: "Follow the deployment (off)" });
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    // The group whose access this decides, with where to manage it.
    const group = await screen.findByRole("list", { name: "Deployment admins" });
    expect(group.textContent).toContain("Ops Lead");
    expect(group.textContent).toContain("sre@acme.io");

    fireEvent.click(screen.getByRole("button", { name: "On" }));
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenCalledWith({
        deploymentAdminsAllWorkspaces: true,
      }),
    );
    expect((await screen.findByRole("button", { name: "On" })).getAttribute("aria-pressed")).toBe(
      "true",
    );

    api.updateDeploymentSettings.mockResolvedValue(settings());
    fireEvent.click(screen.getByRole("button", { name: "Follow the deployment (off)" }));
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenLastCalledWith({
        deploymentAdminsAllWorkspaces: null,
      }),
    );
  });
});
