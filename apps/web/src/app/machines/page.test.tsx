import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The Machines page with a remote workspace's machine: the host list carries
// the connection that started it (`remoteWorkspaceConnectionId`,
// docs/remote-workspaces.md), so
// "Stop workspace" stops it through that connection directly. Everything
// around the machine card is mocked.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const api = vi.hoisted(() => ({
  listRemoteWorkspaceConnections: vi.fn(),
  stopRemoteWorkspace: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
const hostList = vi.hoisted(() => ({ hosts: [] as any[] }));
vi.mock("@/hooks/use-local-hosts", () => ({
  useLocalHosts: () => ({
    hosts: hostList.hosts,
    loading: false,
    refetch: vi.fn(),
    replaceHost: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-work-feed", () => ({
  useWorkFeed: () => ({ rows: [], loading: false, refetch: vi.fn() }),
}));
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: () => {} }));
vi.mock("@/components/role-gate", () => ({
  IfCanMutate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/components/work-row", () => ({ WorkRowView: () => null }));
vi.mock("@/components/local/automations-section", () => ({ AutomationsSection: () => null }));
vi.mock("@/components/local/pair-machine", () => ({ PairMachineGuide: () => null }));
vi.mock("@/components/local/host-dirs", () => ({
  AddDirForm: () => null,
  HostDirList: () => null,
  dirsLockedReason: () => "Optio manages this workspace's directories",
}));
vi.mock("@/components/local/host-concurrency", () => ({ HostConcurrency: () => null }));
vi.mock("@/components/local/host-merge", () => ({
  likelySameComputer: () => false,
  mergeTargets: () => [],
}));

import MachinesPage from "./page";

const coderMachine = {
  id: "host-1",
  name: "optio-fix-a1b2c3",
  platform: "linux",
  state: "online",
  dirs: [{ path: "/home/coder/repo" }],
  origin: "coder",
  remoteWorkspaceId: "w1",
  remoteWorkspaceName: "optio-fix-a1b2c3",
  remoteWorkspaceConnectionId: "conn-9",
  lastSeenAt: null,
};

beforeEach(() => {
  api.listRemoteWorkspaceConnections.mockReset();
  api.stopRemoteWorkspace.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Machines → a remote workspace", () => {
  it("stops the workspace through the connection the host names", async () => {
    hostList.hosts = [coderMachine];
    api.stopRemoteWorkspace.mockResolvedValue({ ok: true, status: "pending" });
    render(<MachinesPage />);
    expect(screen.getByText("Coder")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Stop workspace/ }));
    await waitFor(() => expect(api.stopRemoteWorkspace).toHaveBeenCalledWith("conn-9", "w1"));
    expect(api.listRemoteWorkspaceConnections).not.toHaveBeenCalled();
  });

  it("offers no Stop on a paired laptop", () => {
    hostList.hosts = [{ ...coderMachine, origin: "machine", remoteWorkspaceId: null }];
    render(<MachinesPage />);
    expect(screen.queryByRole("button", { name: /Stop workspace/ })).not.toBeInTheDocument();
  });
});
