import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getDeploymentSettings: vi.fn(),
  updateDeploymentSettings: vi.fn(),
  listWorkspaceDirectory: vi.fn(),
  joinWorkspaceAsAdmin: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { DeploymentAdminWorkspaces } from "./deployment-admin-workspaces";

const off = { value: false, source: "environment", environment: false };
const on = { value: true, source: "app", environment: false };
const settings = (over: Record<string, unknown> = {}) => ({
  workspaceCreation: { value: "everyone", source: "environment", environment: "everyone" },
  deploymentAdminsJoinAnyWorkspace: off,
  canEdit: true,
  mayCreateWorkspace: true,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DeploymentAdminWorkspaces", () => {
  it("is not shown to someone who isn't a deployment admin", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings({ canEdit: false }));
    const { container } = render(<DeploymentAdminWorkspaces />);
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("is off by default and lists no workspace until it is turned on", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.updateDeploymentSettings.mockResolvedValue(
      settings({ deploymentAdminsJoinAnyWorkspace: on }),
    );
    api.listWorkspaceDirectory.mockResolvedValue({
      workspaces: [
        { id: "w1", name: "Acme", slug: "acme", members: 3, role: null },
        { id: "w2", name: "Mine", slug: "mine", members: 1, role: "admin" },
      ],
    });
    render(<DeploymentAdminWorkspaces />);
    const follow = await screen.findByRole("button", { name: "Follow the deployment (off)" });
    expect(follow.getAttribute("aria-pressed")).toBe("true");
    expect(api.listWorkspaceDirectory).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "On" }));
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenCalledWith({
        deploymentAdminsJoinAnyWorkspace: true,
      }),
    );
    expect(await screen.findByText("Acme")).toBeTruthy();
    // Already an admin of Mine: nothing to join there.
    expect(screen.queryByRole("button", { name: "Join Mine as an admin" })).toBeNull();

    api.joinWorkspaceAsAdmin.mockResolvedValue({ ok: true, result: "joined" });
    fireEvent.click(screen.getByRole("button", { name: "Join Acme as an admin" }));
    await waitFor(() => expect(api.joinWorkspaceAsAdmin).toHaveBeenCalledWith("w1"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Join Acme as an admin" })).toBeNull(),
    );
  });
});
