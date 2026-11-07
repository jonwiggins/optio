import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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
  api.getDeploymentSettings.mockResolvedValue({ mayCreateWorkspace: false });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("workspace switcher without a stored workspace", () => {
  it("names the workspace the server served the page in, not the first listed", async () => {
    api.listWorkspaces.mockResolvedValue({
      workspaces: [
        { id: "ws-a", name: "Alpha", slug: "alpha", role: "member" },
        { id: "ws-b", name: "Beta", slug: "beta", role: "member" },
      ],
      currentWorkspaceId: "ws-b",
    });
    render(<WorkspaceSwitcher />);
    await waitFor(() => expect(localStorage.getItem("optio_workspace_id")).toBe("ws-b"));
    expect(await screen.findByText("Beta")).toBeTruthy();
  });
});
