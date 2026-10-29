import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
const api = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  switchWorkspace: vi.fn(),
  getDeploymentSettings: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
import { WorkspaceSwitcher } from "./workspace-switcher";
beforeEach(() => {
  localStorage.clear();
  api.listWorkspaces.mockResolvedValue({
    workspaces: [{ id: "ws-1", name: "Acme", slug: "acme", role: "admin" }],
  });
  api.getDeploymentSettings.mockResolvedValue({ mayCreateWorkspace: true });
  api.switchWorkspace.mockResolvedValue({ ok: true });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: vi.fn(), assign: vi.fn() },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
async function open() {
  render(<WorkspaceSwitcher />);
  fireEvent.click(await screen.findByRole("button", { name: /Switch workspace/ }));
  await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
}
describe("workspace creation policy", () => {
  it("creates a workspace when the server grants permission", async () => {
    api.createWorkspace.mockResolvedValue({
      workspace: { id: "ws-2", name: "Platform", slug: "platform" },
    });
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "New workspace" }));
    fireEvent.change(screen.getByPlaceholderText("Workspace name"), {
      target: { value: "Platform" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(api.createWorkspace).toHaveBeenCalledWith({ name: "Platform", slug: "platform" }),
    );
  });
  it("hides creation when the server refuses permission", async () => {
    api.getDeploymentSettings.mockResolvedValue({ mayCreateWorkspace: false });
    await open();
    expect(screen.queryByRole("button", { name: "New workspace" })).toBeNull();
  });
  it("hides creation if the policy cannot be read", async () => {
    api.getDeploymentSettings.mockRejectedValue(new Error("offline"));
    await open();
    expect(screen.queryByRole("button", { name: "New workspace" })).toBeNull();
  });
  it("waits for permission before offering creation", async () => {
    api.getDeploymentSettings.mockReturnValue(new Promise(() => {}));
    await open();
    expect(screen.queryByRole("button", { name: "New workspace" })).toBeNull();
  });
});
