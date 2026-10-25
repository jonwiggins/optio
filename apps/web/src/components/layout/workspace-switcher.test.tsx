import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  listDiscoverableWorkspaces: vi.fn(),
  joinWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  switchWorkspace: vi.fn(),
  searchGroups: vi.fn(),
  getDeploymentSettings: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { WorkspaceSwitcher } from "./workspace-switcher";

const reload = vi.fn();

beforeEach(() => {
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload, assign: vi.fn() },
  });
  localStorage.clear();
  api.listWorkspaces.mockResolvedValue({
    workspaces: [{ id: "ws-1", name: "Acme", slug: "acme", role: "admin" }],
  });
  api.listDiscoverableWorkspaces.mockResolvedValue({ workspaces: [] });
  api.switchWorkspace.mockResolvedValue({ ok: true });
  api.searchGroups.mockResolvedValue({ groups: [] });
  // A deployment admin, who may create workspaces and name their groups.
  api.getDeploymentSettings.mockResolvedValue({
    workspaceCreation: { value: "admins", source: "environment", environment: "admins" },
    canEdit: true,
    mayCreateWorkspace: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const openMenu = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /Switch workspace/ }));
};

describe("WorkspaceSwitcher", () => {
  it("lists the workspaces the person's groups open and joins one", async () => {
    api.listDiscoverableWorkspaces.mockResolvedValue({
      workspaces: [{ id: "ws-9", name: "Data", slug: "data", description: null, role: "viewer" }],
    });
    api.joinWorkspace.mockResolvedValue({ ok: true, role: "viewer" });
    render(<WorkspaceSwitcher />);
    await openMenu();

    fireEvent.click(await screen.findByRole("button", { name: "Join Data as viewer" }));
    await waitFor(() => expect(api.joinWorkspace).toHaveBeenCalledWith("ws-9"));
    await waitFor(() => expect(api.switchWorkspace).toHaveBeenCalledWith("ws-9"));
  });

  it("shows no Discoverable section without any", async () => {
    render(<WorkspaceSwitcher />);
    await openMenu();
    expect(screen.queryByTestId("discoverable-workspaces")).toBeNull();
  });

  it("creates a workspace accessible to groups, with the role they join as", async () => {
    api.createWorkspace.mockResolvedValue({
      workspace: { id: "ws-2", name: "Platform", slug: "platform" },
    });
    render(<WorkspaceSwitcher />);
    await openMenu();
    fireEvent.click(await screen.findByRole("button", { name: "New workspace" }));

    fireEvent.change(screen.getByPlaceholderText("Platform team"), {
      target: { value: "Platform" },
    });
    const groups = screen.getByRole("combobox", { name: "Accessible to groups" });
    fireEvent.focus(groups);
    fireEvent.change(groups, { target: { value: "eng-platform" } });
    fireEvent.keyDown(groups, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Viewer" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(api.createWorkspace).toHaveBeenCalledWith({
        name: "Platform",
        slug: "platform",
        accessGroups: ["eng-platform"],
        accessGroupsRole: "viewer",
      }),
    );
  });

  it("creates an invite-only workspace when no group is named", async () => {
    api.createWorkspace.mockResolvedValue({
      workspace: { id: "ws-3", name: "Solo", slug: "solo" },
    });
    render(<WorkspaceSwitcher />);
    await openMenu();
    fireEvent.click(await screen.findByRole("button", { name: "New workspace" }));
    fireEvent.change(screen.getByPlaceholderText("Platform team"), { target: { value: "Solo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(api.createWorkspace).toHaveBeenCalledWith({ name: "Solo", slug: "solo" }),
    );
  });

  // Only a deployment admin creates workspaces, unless the deployment
  // lets everyone; only a deployment admin names their groups.
  it("offers no New workspace to someone who may not create one", async () => {
    api.getDeploymentSettings.mockResolvedValue({
      workspaceCreation: { value: "admins", source: "environment", environment: "admins" },
      canEdit: false,
      mayCreateWorkspace: false,
    });
    render(<WorkspaceSwitcher />);
    await openMenu();
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "New workspace" })).toBeNull();
  });

  it("lets everyone create one when the deployment says so, without naming groups", async () => {
    api.getDeploymentSettings.mockResolvedValue({
      workspaceCreation: { value: "everyone", source: "app", environment: "admins" },
      canEdit: false,
      mayCreateWorkspace: true,
    });
    render(<WorkspaceSwitcher />);
    await openMenu();
    fireEvent.click(await screen.findByRole("button", { name: "New workspace" }));
    expect(screen.queryByRole("combobox", { name: "Accessible to groups" })).toBeNull();
  });

  it("offers none when the settings can't be read", async () => {
    api.getDeploymentSettings.mockRejectedValue(new Error("404"));
    render(<WorkspaceSwitcher />);
    await openMenu();
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "New workspace" })).toBeNull();
  });
});
