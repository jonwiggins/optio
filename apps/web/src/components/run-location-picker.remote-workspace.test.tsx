import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const hostsState = vi.hoisted(() => ({
  hosts: [] as any[],
  loading: false,
  replaceHost: vi.fn(),
}));
vi.mock("@/hooks/use-local-hosts", () => ({
  useLocalHosts: () => ({ ...hostsState, refetch: vi.fn() }),
}));

const addLocalHostDir = vi.fn();
const remote = vi.hoisted(() => ({
  connections: [] as any[],
  templates: [] as any[],
  parameters: [] as any[],
  workspaces: [] as any[],
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    getAuthProviders: () => Promise.resolve({ providers: [], authDisabled: true }),
    addLocalHostDir: (...args: unknown[]) => addLocalHostDir(...args),
    removeLocalHostDir: vi.fn(),
    listRemoteWorkspaceConnections: () => Promise.resolve({ connections: remote.connections }),
    listRemoteWorkspaceTemplates: () =>
      Promise.resolve({ organizationId: "org1", templates: remote.templates }),
    getRemoteWorkspaceTemplateParameters: () => Promise.resolve({ parameters: remote.parameters }),
    listRemoteWorkspaces: () => Promise.resolve({ workspaces: remote.workspaces }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { RunLocationPicker, type RunLocationValue } from "./run-location-picker";
import { EMPTY_REMOTE_WORKSPACE } from "@/components/remote-workspaces/location";

const LOCAL: RunLocationValue = {
  runTarget: "local",
  localHostId: "",
  localDir: "",
  localSessionMode: "headless",
};

beforeEach(() => {
  remote.connections = [];
  remote.templates = [];
  remote.parameters = [];
  remote.workspaces = [];
  hostsState.hosts = [];
  hostsState.loading = false;
  hostsState.replaceHost.mockReset();
  addLocalHostDir.mockReset();
});

afterEach(() => cleanup());

const connection = (extra: Record<string, unknown> = {}) => ({
  id: "c1",
  provider: "coder",
  name: "Team workspaces",
  url: "https://remote.example.com",
  enabled: true,
  ownerUserId: null,
  ownerTeamId: null,
  templateId: "t1",
  templateVersionId: null,
  templateName: "Base",
  defaultParameters: { region: "eu" },
  ttlMs: 8 * 60 * 60_000,
  deleteWhenDone: false,
  ...extra,
});

const param = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  displayName: null,
  description: null,
  type: "string",
  mutable: true,
  required: false,
  defaultValue: null,
  ephemeral: false,
  options: [],
  setByOptio: name.startsWith("optio_"),
  ...extra,
});

const REMOTE: RunLocationValue = {
  ...LOCAL,
  remoteWorkspace: { ...EMPTY_REMOTE_WORKSPACE, connectionId: "c1" },
};

describe("RunLocationPicker in a remote workspace", () => {
  it("offers no third place while there is no remote-workspace connection (the default)", async () => {
    render(
      <RunLocationPicker
        value={{ ...LOCAL, runTarget: "cluster" }}
        onChange={vi.fn()}
        kind="task"
      />,
    );
    // Let the connections answer (none) arrive.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /A remote workspace/ })).not.toBeInTheDocument();
  });

  it("offers A remote workspace as a third place and picks it as a local run", async () => {
    remote.connections = [connection()];
    const onChange = vi.fn();
    render(
      <RunLocationPicker
        value={{ ...LOCAL, runTarget: "cluster" }}
        onChange={onChange}
        kind="task"
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /A remote workspace/ }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ runTarget: "local", remoteWorkspace: EMPTY_REMOTE_WORKSPACE }),
    );
  });

  it("says where to add a connection when there is none", async () => {
    render(<RunLocationPicker value={REMOTE} onChange={vi.fn()} kind="job" />);
    expect(await screen.findByText("No remote-workspace connection yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Settings → Integrations → Remote workspaces/ }),
    ).toHaveAttribute("href", "/settings#remote-workspaces");
  });

  it("can't be picked when the form says so (an edit of work that runs elsewhere), and says why", async () => {
    remote.connections = [connection()];
    const reason = "Saved work keeps where it runs — start new work to use a remote workspace.";
    render(
      <RunLocationPicker
        value={{ ...LOCAL, runTarget: "cluster" }}
        onChange={vi.fn()}
        kind="job"
        remoteWorkspaceDisabled={reason}
      />,
    );
    const card = await screen.findByRole("button", { name: /A remote workspace/ });
    expect(card).toBeDisabled();
    expect(card).toHaveTextContent(reason);
  });

  it("shows the default template's parameters, not the ones Optio fills", async () => {
    remote.connections = [connection()];
    remote.templates = [
      {
        id: "t1",
        name: "base",
        displayName: "Base",
        description: null,
        organizationId: "org1",
        activeVersionId: "v1",
      },
    ];
    remote.parameters = [
      param("optio_token"),
      param("optio_checkout_dir"),
      param("region", {
        displayName: "Region",
        options: [
          { name: "Europe", value: "eu", description: null },
          { name: "US", value: "us", description: null },
        ],
      }),
      param("repo_url"),
    ];
    const onChange = vi.fn();
    render(<RunLocationPicker value={REMOTE} onChange={onChange} kind="task" />);

    const region = await screen.findByLabelText("Region");
    // The connection's default shows until the work picks another value.
    expect(region).toHaveValue("eu");
    expect(screen.queryByLabelText("optio_token")).not.toBeInTheDocument();
    // A Task's repository has its own field (it is the template's repo_url too).
    expect(screen.queryByLabelText("repo_url")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Repository")).toBeInTheDocument();
    expect(screen.getByLabelText("Template")).toHaveTextContent("Default — Base");
    expect(
      screen.getByText(/stops when the run ends, or after 8 h at the latest/),
    ).toBeInTheDocument();

    fireEvent.change(region, { target: { value: "us" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        remoteWorkspace: expect.objectContaining({ parameters: { region: "us" } }),
      }),
    );
  });

  it("reports the typed repository as the Task's repo", async () => {
    remote.connections = [connection()];
    const onRepoUrlChange = vi.fn();
    render(
      <RunLocationPicker
        value={{
          ...REMOTE,
          remoteWorkspace: {
            ...REMOTE.remoteWorkspace!,
            repoUrl: "https://gitlab.example.com/team/app",
          },
        }}
        onChange={vi.fn()}
        onRepoUrlChange={onRepoUrlChange}
        kind="task"
      />,
    );
    await waitFor(() =>
      expect(onRepoUrlChange).toHaveBeenLastCalledWith("https://gitlab.example.com/team/app"),
    );
  });

  it("speaks each provider's words: a Daytona connection's snapshots and sandboxes", async () => {
    remote.connections = [
      connection({
        id: "d1",
        provider: "daytona",
        name: "Sandboxes",
        url: "",
        templateId: null,
        templateName: null,
        defaultParameters: {},
        ttlMs: null,
      }),
    ];
    remote.templates = [
      {
        id: "optio-node",
        name: "optio-node",
        displayName: null,
        description: null,
        organizationId: null,
        activeVersionId: "optio-node",
      },
    ];
    remote.parameters = [param("target", { displayName: "Region" })];
    render(
      <RunLocationPicker
        value={{ ...LOCAL, remoteWorkspace: { ...EMPTY_REMOTE_WORKSPACE, connectionId: "d1" } }}
        onChange={vi.fn()}
        kind="job"
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Snapshot")).toHaveTextContent("Pick a snapshot…"),
    );
    expect(screen.getByRole("button", { name: "New sandbox" })).toBeInTheDocument();
    expect(screen.getByLabelText("Checkout")).toHaveAttribute("placeholder", "/home/daytona/repo");
    expect(screen.getByText(/The sandbox stops when the run ends\./)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sandboxes · Daytona" })).toBeInTheDocument();
  });

  it("lists your running and stopped workspaces for Existing workspace", async () => {
    remote.connections = [connection()];
    remote.workspaces = [
      { id: "w1", name: "dev", status: "running", templateName: "Base" },
      { id: "w2", name: "old", status: "stopped", templateName: null },
      { id: "w3", name: "broken", status: "failed", templateName: null },
    ];
    render(
      <RunLocationPicker
        value={{
          ...REMOTE,
          remoteWorkspace: { ...REMOTE.remoteWorkspace!, source: "existing" },
        }}
        onChange={vi.fn()}
        kind="job"
      />,
    );
    expect(await screen.findByRole("option", { name: "dev — running · Base" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "old — stopped" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /broken/ })).not.toBeInTheDocument();
  });
});
