import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let currentUser: any = { userId: "u1", isAdmin: true, adminTeamIds: [] };
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));
vi.mock("@/hooks/use-my-teams", () => ({ useMyTeams: () => ({ myTeams: [], loaded: true }) }));

const api = vi.hoisted(() => ({
  listRemoteWorkspaceConnections: vi.fn(),
  createRemoteWorkspaceConnection: vi.fn(),
  updateRemoteWorkspaceConnection: vi.fn(),
  deleteRemoteWorkspaceConnection: vi.fn(),
  testRemoteWorkspaceConnection: vi.fn(),
  listRemoteWorkspaceTemplates: vi.fn(),
  getRemoteWorkspaceTemplateParameters: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));

import { RemoteWorkspaceConnections } from "./remote-workspace-connections";

const row = (extra: Record<string, unknown> = {}) => ({
  id: "c1",
  provider: "coder",
  workspaceId: "ws",
  ownerUserId: null,
  ownerTeamId: null,
  name: "Corp Coder",
  url: "https://coder.example.com",
  hasToken: true,
  tokenHint: "wxyz",
  caPem: null,
  insecureSkipVerify: false,
  organizationId: null,
  templateId: "t1",
  templateVersionId: null,
  templateName: "Base",
  defaultParameters: {},
  ttlMs: 8 * 60 * 60_000,
  deleteWhenDone: false,
  lastTestedAt: null,
  lastError: null,
  enabled: true,
  canEdit: true,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...extra,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listRemoteWorkspaceTemplates.mockResolvedValue({ organizationId: "org1", templates: [] });
  api.getRemoteWorkspaceTemplateParameters.mockResolvedValue({ parameters: [] });
  currentUser = { userId: "u1", isAdmin: true, adminTeamIds: [] };
});

afterEach(() => cleanup());

describe("Settings → Integrations → Remote workspaces (Coder)", () => {
  it("lists the visible connections with whose each is, and never a token", async () => {
    api.listRemoteWorkspaceConnections.mockResolvedValue({
      connections: [
        row(),
        row({ id: "c2", name: "Mine", ownerUserId: "u1", tokenHint: "abcd", canEdit: true }),
        row({
          id: "c3",
          name: "Platform's",
          ownerUserId: "u2",
          ownerTeamId: "t9",
          ownerTeamName: "Platform",
          canEdit: false,
        }),
      ],
    });
    render(<RemoteWorkspaceConnections />);

    const org = await screen.findByTestId("connection-c1");
    expect(within(org).getByText("Organization")).toBeInTheDocument();
    expect(within(org).getByText(/token …wxyz/)).toBeInTheDocument();
    expect(within(org).getByText(/Base · stops after 8 h/)).toBeInTheDocument();
    expect(within(screen.getByTestId("connection-c2")).getByText("Private")).toBeInTheDocument();
    const team = screen.getByTestId("connection-c3");
    expect(within(team).getByText("Team · Platform")).toBeInTheDocument();
    // A row the viewer can't change offers no Test / Edit / Remove.
    expect(within(team).queryByRole("button")).not.toBeInTheDocument();
  });

  it("adds a connection with the right body, tests it, and doesn't echo the token", async () => {
    api.listRemoteWorkspaceConnections.mockResolvedValueOnce({ connections: [] });
    api.createRemoteWorkspaceConnection.mockResolvedValue({ connection: row({ id: "new1" }) });
    api.testRemoteWorkspaceConnection.mockResolvedValue({
      ok: true,
      user: { username: "optio-bot" },
    });
    api.listRemoteWorkspaceConnections.mockResolvedValue({
      connections: [row({ id: "new1", lastTestedAt: "2026-10-23T00:00:00Z" })],
    });
    render(<RemoteWorkspaceConnections />);

    fireEvent.click((await screen.findAllByRole("button", { name: /Add connection/ }))[0]);
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://coder.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Session token"), {
      target: { value: "secret-token-1234" },
    });
    expect(screen.getByLabelText("Session token")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByLabelText("Skip TLS verification"));
    expect(
      screen.getByText(/Anyone between Optio and Coder could read the token/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Stop after (hours)"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and test" }));

    await waitFor(() => expect(api.createRemoteWorkspaceConnection).toHaveBeenCalledTimes(1));
    expect(api.createRemoteWorkspaceConnection.mock.calls[0][0]).toEqual({
      provider: "coder",
      name: "Coder",
      url: "https://coder.example.com",
      token: "secret-token-1234",
      caPem: null,
      insecureSkipVerify: true,
      organizationId: null,
      templateId: null,
      templateVersionId: null,
      templateName: null,
      defaultParameters: {},
      ttlMs: 4 * 60 * 60_000,
      deleteWhenDone: false,
      owner: "workspace",
    });
    await waitFor(() => expect(api.testRemoteWorkspaceConnection).toHaveBeenCalledWith("new1"));
    // The form reopens on the saved row: its token field is empty, the hint shows.
    await waitFor(() =>
      expect(api.listRemoteWorkspaceTemplates).toHaveBeenCalledWith("new1", undefined),
    );
    expect(screen.queryByDisplayValue("secret-token-1234")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("secret-token-1234");
    expect(
      screen.getByText("Stored, ending in …wxyz. Leave empty to keep it."),
    ).toBeInTheDocument();
  });

  it("a non-admin adds their own connection", async () => {
    currentUser = { userId: "u1", isAdmin: false, adminTeamIds: [] };
    api.listRemoteWorkspaceConnections.mockResolvedValue({ connections: [] });
    api.createRemoteWorkspaceConnection.mockResolvedValue({ connection: row({ id: "n2" }) });
    api.testRemoteWorkspaceConnection.mockResolvedValue({ ok: false, error: "401 Unauthorized" });
    render(<RemoteWorkspaceConnections />);
    fireEvent.click((await screen.findAllByRole("button", { name: /Add connection/ }))[0]);
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://c.example" } });
    fireEvent.change(screen.getByLabelText("Session token"), { target: { value: "t" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and test" }));
    await waitFor(() =>
      expect(api.createRemoteWorkspaceConnection).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "me" }),
      ),
    );
  });

  it("changes a tested connection's default template and keeps the token when left blank", async () => {
    api.listRemoteWorkspaceConnections.mockResolvedValue({
      connections: [row({ templateId: null, templateName: null, lastTestedAt: "2026-10-22" })],
    });
    api.listRemoteWorkspaceTemplates.mockResolvedValue({
      organizationId: "org1",
      templates: [
        {
          id: "t2",
          name: "k8s",
          displayName: "Kubernetes",
          description: null,
          organizationId: "org1",
          activeVersionId: "v2",
        },
      ],
    });
    api.getRemoteWorkspaceTemplateParameters.mockResolvedValue({
      parameters: [
        {
          name: "optio_token",
          displayName: null,
          description: null,
          type: "string",
          mutable: true,
          required: false,
          defaultValue: "",
          ephemeral: true,
          options: [],
          setByOptio: true,
        },
        {
          name: "cpu",
          displayName: "CPU",
          description: null,
          type: "number",
          mutable: true,
          required: false,
          defaultValue: "2",
          ephemeral: false,
          options: [],
          setByOptio: false,
        },
      ],
    });
    api.updateRemoteWorkspaceConnection.mockResolvedValue({ connection: row() });
    render(<RemoteWorkspaceConnections />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit Corp Coder" }));
    const select = await screen.findByLabelText("Default template");
    fireEvent.change(select, { target: { value: "t2" } });
    const cpu = await screen.findByLabelText("CPU");
    expect(screen.queryByLabelText("optio_token")).not.toBeInTheDocument();
    fireEvent.change(cpu, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.updateRemoteWorkspaceConnection).toHaveBeenCalledTimes(1));
    const [id, body] = api.updateRemoteWorkspaceConnection.mock.calls[0];
    expect(id).toBe("c1");
    expect(body).toMatchObject({
      templateId: "t2",
      templateName: "Kubernetes",
      templateVersionId: null,
      defaultParameters: { cpu: "4" },
    });
    expect(body).not.toHaveProperty("token");
  });
});

describe("Settings → Integrations → Remote workspaces (the other providers)", () => {
  it("adds a Daytona connection: its own words, and its cloud's API when the URL is left blank", async () => {
    api.listRemoteWorkspaceConnections.mockResolvedValue({ connections: [] });
    api.createRemoteWorkspaceConnection.mockResolvedValue({
      connection: row({ id: "d1", provider: "daytona", name: "Daytona", url: "" }),
    });
    api.testRemoteWorkspaceConnection.mockResolvedValue({ ok: true, user: { username: "" } });
    render(<RemoteWorkspaceConnections />);
    fireEvent.click((await screen.findAllByRole("button", { name: /Add connection/ }))[0]);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "daytona" } });
    expect(screen.getByLabelText("Name")).toHaveValue("Daytona");
    expect(screen.getByLabelText("URL")).toHaveAttribute(
      "placeholder",
      "https://app.daytona.io/api",
    );
    expect(screen.getByLabelText("Checkout")).toHaveAttribute("placeholder", "/home/daytona/repo");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "dtn_secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and test" }));
    await waitFor(() => expect(api.createRemoteWorkspaceConnection).toHaveBeenCalledTimes(1));
    expect(api.createRemoteWorkspaceConnection.mock.calls[0][0]).toMatchObject({
      provider: "daytona",
      name: "Daytona",
      url: "",
      token: "dtn_secret",
      owner: "workspace",
    });
    await waitFor(() => expect(api.testRemoteWorkspaceConnection).toHaveBeenCalledWith("d1"));
  });

  it("makes a GitHub Codespaces connection a person's own", async () => {
    api.listRemoteWorkspaceConnections.mockResolvedValue({ connections: [] });
    api.createRemoteWorkspaceConnection.mockResolvedValue({
      connection: row({ id: "g1", provider: "codespaces", name: "GitHub Codespaces", url: "" }),
    });
    api.testRemoteWorkspaceConnection.mockResolvedValue({ ok: true, user: { username: "octo" } });
    render(<RemoteWorkspaceConnections />);
    fireEvent.click((await screen.findAllByRole("button", { name: /Add connection/ }))[0]);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codespaces" } });
    expect(screen.getByText(/A GitHub Codespaces connection is your own/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Personal access token"), {
      target: { value: "ghp_secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add and test" }));
    await waitFor(() =>
      expect(api.createRemoteWorkspaceConnection).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "codespaces", owner: "me" }),
      ),
    );
  });

  it("lists each connection with its provider", async () => {
    api.listRemoteWorkspaceConnections.mockResolvedValue({
      connections: [row({ id: "e1", provider: "e2b", name: "Sandboxes", url: "" })],
    });
    render(<RemoteWorkspaceConnections />);
    const r = await screen.findByTestId("connection-e1");
    expect(within(r).getByText("E2B")).toBeInTheDocument();
    expect(within(r).getByText(/https:\/\/api\.e2b\.app/)).toBeInTheDocument();
  });
});
