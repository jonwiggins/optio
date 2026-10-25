import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const api = vi.hoisted(() => ({
  listRemoteWorkspaceConnections: vi.fn(),
  stopRemoteWorkspace: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));

import { RemoteWorkspaceBadge, StopRemoteWorkspace, stopRemoteWorkspaceHost } from "./machine";

const host = {
  name: "optio-fix-a1b2c3",
  origin: "coder",
  remoteWorkspaceId: "w1",
  remoteWorkspaceName: "optio-fix-a1b2c3",
};

beforeEach(() => {
  api.listRemoteWorkspaceConnections.mockReset();
  api.stopRemoteWorkspace.mockReset();
});
afterEach(() => cleanup());

describe("a remote workspace on the Machines page", () => {
  it("badges a workspace's machine with its provider (and the workspace's name when the machine is renamed), and nothing else", () => {
    const { rerender } = render(<RemoteWorkspaceBadge host={{ ...host, name: "my box" }} />);
    expect(screen.getByText("Coder · optio-fix-a1b2c3")).toBeInTheDocument();
    rerender(<RemoteWorkspaceBadge host={{ ...host, origin: "daytona" }} />);
    expect(screen.getByText("Daytona")).toBeInTheDocument();
    rerender(<RemoteWorkspaceBadge host={{ name: "laptop", origin: "machine" }} />);
    expect(screen.queryByText(/Coder|Daytona/)).not.toBeInTheDocument();
    rerender(<StopRemoteWorkspace host={{ name: "laptop" }} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<StopRemoteWorkspace host={host} />);
    expect(screen.getByRole("button", { name: /Stop workspace/ })).toBeInTheDocument();
    // E2B keeps a sandbox paused, not stopped.
    rerender(<StopRemoteWorkspace host={{ ...host, origin: "e2b" }} />);
    expect(screen.getByRole("button", { name: /Pause workspace/ })).toBeInTheDocument();
  });

  it("stops through the connection that reaches the workspace, yours first", async () => {
    api.listRemoteWorkspaceConnections.mockResolvedValue({
      connections: [
        { id: "org", name: "Org", provider: "coder", ownerUserId: null, ownerTeamId: null },
        { id: "mine", name: "Mine", provider: "coder", ownerUserId: "u1", ownerTeamId: null },
      ],
    });
    api.stopRemoteWorkspace.mockImplementation(async (id: string) => {
      if (id === "mine") throw new Error("404");
      return { ok: true, status: "pending" };
    });
    await expect(stopRemoteWorkspaceHost(host)).resolves.toBe("pending");
    expect(api.listRemoteWorkspaceConnections).toHaveBeenCalledWith("coder");
    expect(api.stopRemoteWorkspace.mock.calls.map((c) => c[0])).toEqual(["mine", "org"]);
  });

  it("uses the named connection when the host carries one", async () => {
    api.stopRemoteWorkspace.mockResolvedValue({ ok: true, status: "pending" });
    await stopRemoteWorkspaceHost({ ...host, remoteWorkspaceConnectionId: "c9" });
    expect(api.listRemoteWorkspaceConnections).not.toHaveBeenCalled();
    expect(api.stopRemoteWorkspace).toHaveBeenCalledWith("c9", "w1");
  });
});
