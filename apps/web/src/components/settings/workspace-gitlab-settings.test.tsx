import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getWorkspaceGitLab: vi.fn(),
  addWorkspaceGitLabServer: vi.fn(),
  updateWorkspaceGitLabServer: vi.fn(),
  removeWorkspaceGitLabServer: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { WorkspaceGitLabSettingsCard } from "./workspace-gitlab-settings";

const server = (over: Record<string, unknown> = {}) => ({
  id: "s-1",
  host: "git.corp.example",
  accountUsername: "team-bot",
  accountName: "Team Bot",
  isDefault: true,
  hasToken: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});
const settings = (over: Record<string, unknown> = {}) => ({
  servers: [server()],
  allowedHosts: ["gitlab.com", "git.corp.example", "git.other.example:8443"],
  deploymentFallback: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getWorkspaceGitLab.mockResolvedValue(settings());
  api.addWorkspaceGitLabServer.mockResolvedValue({ server: server({ id: "s-2" }) });
  api.updateWorkspaceGitLabServer.mockResolvedValue({ server: server() });
  api.removeWorkspaceGitLabServer.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("Workspace Settings → GitLab", () => {
  it("lists the workspace's servers and who each signs in as, never a token", async () => {
    render(<WorkspaceGitLabSettingsCard isAdmin />);
    const row = await screen.findByTestId("gitlab-server-git.corp.example");
    expect(within(row).getByText("Default")).toBeInTheDocument();
    expect(within(row).getByText("signs in as @team-bot")).toBeInTheDocument();
    expect(screen.getByText(/no other workspace can use them/)).toBeInTheDocument();
    expect(screen.getByText(/doesn't use the deployment's GitLab credentials/)).toBeInTheDocument();
  });

  it("says so when the workspace falls back to the deployment's credentials", async () => {
    api.getWorkspaceGitLab.mockResolvedValue(settings({ servers: [], deploymentFallback: true }));
    render(<WorkspaceGitLabSettingsCard isAdmin />);
    expect(await screen.findByTestId("gitlab-empty")).toBeInTheDocument();
    expect(screen.getByText(/uses the deployment's GitLab credentials/)).toBeInTheDocument();
  });

  it("is read-only for members", async () => {
    render(<WorkspaceGitLabSettingsCard isAdmin={false} />);
    await screen.findByTestId("gitlab-server-git.corp.example");
    expect(screen.queryByRole("button", { name: /Add GitLab server/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Replace token/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Only workspace admins/)).toBeInTheDocument();
  });

  it("adds a server from the operator's hosts with a token, then reloads", async () => {
    render(<WorkspaceGitLabSettingsCard isAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: /Add GitLab server/ }));
    const select = screen.getByLabelText("GitLab server") as HTMLSelectElement;
    // Hosts already set up aren't offered again.
    expect([...select.options].map((o) => o.value)).toEqual([
      "gitlab.com",
      "git.other.example:8443",
    ]);
    fireEvent.change(select, { target: { value: "git.other.example:8443" } });
    fireEvent.change(screen.getByLabelText("Access token"), {
      target: { value: "  glpat-other  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.addWorkspaceGitLabServer).toHaveBeenCalledWith({
        host: "git.other.example:8443",
        token: "glpat-other",
        isDefault: false,
      }),
    );
    await waitFor(() => expect(api.getWorkspaceGitLab).toHaveBeenCalledTimes(2));
  });

  it("shows why a server was refused, and keeps the form", async () => {
    api.addWorkspaceGitLabServer.mockRejectedValue(
      new Error("The token didn't sign in to gitlab.com: GitLab returned 401"),
    );
    api.getWorkspaceGitLab.mockResolvedValue(settings({ servers: [] }));
    render(<WorkspaceGitLabSettingsCard isAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: /Add GitLab server/ }));
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "glpat-bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/GitLab returned 401/);
    expect(screen.getByLabelText("Access token")).toBeInTheDocument();
    // The first server is the default without asking.
    expect(api.addWorkspaceGitLabServer).toHaveBeenCalledWith(
      expect.objectContaining({ isDefault: true }),
    );
  });

  it("replaces a token, makes a server the default, and removes one", async () => {
    api.getWorkspaceGitLab.mockResolvedValue(
      settings({
        servers: [server(), server({ id: "s-2", host: "gitlab.com", isDefault: false })],
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<WorkspaceGitLabSettingsCard isAdmin />);
    const other = await screen.findByTestId("gitlab-server-gitlab.com");

    fireEvent.click(within(other).getByRole("button", { name: /Make default/ }));
    await waitFor(() =>
      expect(api.updateWorkspaceGitLabServer).toHaveBeenCalledWith("s-2", { isDefault: true }),
    );

    fireEvent.click(within(other).getByRole("button", { name: /Replace token/ }));
    fireEvent.change(within(other).getByLabelText("New token for gitlab.com"), {
      target: { value: "glpat-new" },
    });
    fireEvent.click(within(other).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateWorkspaceGitLabServer).toHaveBeenCalledWith("s-2", { token: "glpat-new" }),
    );

    fireEvent.click(within(other).getByRole("button", { name: "Remove gitlab.com" }));
    await waitFor(() => expect(api.removeWorkspaceGitLabServer).toHaveBeenCalledWith("s-2"));
  });
});
