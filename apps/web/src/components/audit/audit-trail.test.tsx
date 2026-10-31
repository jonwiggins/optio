import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AuditPage, AuditSettings } from "@/lib/audit";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let currentUser: any;
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

const listAudit = vi.fn();
const getAuditSettings = vi.fn();
const setAuditRetention = vi.fn();
const exportAudit = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    listAudit: (...a: unknown[]) => listAudit(...a),
    getAuditSettings: () => getAuditSettings(),
    setAuditRetention: (...a: unknown[]) => setAuditRetention(...a),
    exportAudit: (...a: unknown[]) => exportAudit(...a),
    listWorkspaceMembers: async () => ({
      members: [
        { userId: "u-bob", displayName: "Bob", email: "bob@example.test" },
        { userId: "u-carol", displayName: "Carol", email: "carol@example.test" },
      ],
    }),
    listTeams: async () => ({ teams: [{ id: "t-1", name: "Platform" }] }),
  },
}));

import { AuditTrail } from "./audit-trail";

const page: AuditPage = {
  items: [
    {
      id: "a-1",
      time: new Date().toISOString(),
      workspaceId: "ws-1",
      workspaceName: "Org",
      actor: { id: "u-carol", email: "carol@example.test", name: "Carol" },
      action: "auth.sign_in",
      label: "Signed in",
      success: true,
      clientIp: "10.0.0.5",
      details: { provider: "ldap", via: "cli" },
    },
    {
      id: "a-2",
      time: new Date().toISOString(),
      workspaceId: "ws-1",
      workspaceName: "Org",
      actor: { id: "u-alice", email: "alice@example.test", name: "Alice" },
      action: "workspace.member.add",
      label: "Workspace member added",
      success: true,
      clientIp: null,
      details: { targetUserId: "u-bob" },
    },
    {
      id: "a-3",
      time: new Date().toISOString(),
      workspaceId: null,
      workspaceName: null,
      actor: null,
      action: "auth.sign_in.failure",
      label: "Sign-in refused",
      success: false,
      clientIp: "203.0.113.9",
      details: { reason: "invalid_credentials", username: "mallory" },
    },
  ],
  total: 3,
  limit: 100,
  offset: 0,
  scope: "all",
};

const settings: AuditSettings = {
  retention: {
    days: 365,
    source: "default",
    environmentDays: 365,
    lastPrunedAt: null,
    updatedAt: null,
    updatedBy: null,
  },
  stdout: false,
  canChange: true,
};

beforeEach(() => {
  currentUser = {
    user: { id: "u-alice", workspaceId: "ws-1" },
    isAdmin: true,
    isDeploymentAdmin: true,
    loaded: true,
  };
  listAudit.mockReset().mockResolvedValue(page);
  getAuditSettings.mockReset().mockResolvedValue(settings);
  setAuditRetention.mockReset();
  exportAudit.mockReset();
});
afterEach(() => cleanup());

describe("the Audit page", () => {
  it("lists entries with who, what, from where and the details named", async () => {
    render(<AuditTrail />);
    expect(await screen.findByText("Signed in")).toBeInTheDocument();
    const rows = screen.getAllByTestId("audit-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Carol");
    expect(rows[0].textContent).toContain("from 10.0.0.5");
    expect(rows[1].textContent).toContain("Workspace member added");
    await waitFor(() => expect(rows[1].textContent).toContain("Bob"));
    expect(rows[2].textContent).toContain("Not signed in");
    expect(rows[2].textContent).toContain("refused");
    expect(rows[2].textContent).toContain("Deployment");
    // A deployment admin reads every workspace by default.
    expect(listAudit.mock.calls[0][0]).toContain("workspace=all");
  });

  it("filters by person and action, and exports with the same filters", async () => {
    render(<AuditTrail />);
    await screen.findByText("Signed in");
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "merges" } });
    await waitFor(() => {
      const q = new URLSearchParams(listAudit.mock.calls.at(-1)![0]);
      expect(q.get("action")).toBe("pr.merge,auto_merge");
    });
    // Clicking a person narrows to them.
    fireEvent.click(
      within(screen.getAllByTestId("audit-row")[0]).getByRole("button", { name: "Carol" }),
    );
    await waitFor(() =>
      expect(new URLSearchParams(listAudit.mock.calls.at(-1)![0]).get("userId")).toBe("u-carol"),
    );

    exportAudit.mockResolvedValue({ blob: new Blob(["x"]), filename: "optio-audit.csv" });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: /CSV/ }));
    await waitFor(() => expect(exportAudit).toHaveBeenCalled());
    const q = new URLSearchParams(exportAudit.mock.calls[0][0]);
    expect(q.get("format")).toBe("csv");
    expect(q.get("userId")).toBe("u-carol");
  });

  it("tells members it is for admins and reads nothing", async () => {
    currentUser = { ...currentUser, isAdmin: false, isDeploymentAdmin: false };
    render(<AuditTrail />);
    expect(screen.getByText("The audit trail is for admins")).toBeInTheDocument();
    expect(listAudit).not.toHaveBeenCalled();
    expect(getAuditSettings).not.toHaveBeenCalled();
  });

  it("a workspace admin doesn't pick the workspace", async () => {
    currentUser = { ...currentUser, isDeploymentAdmin: false };
    listAudit.mockResolvedValue({ ...page, scope: "workspace" });
    render(<AuditTrail />);
    await screen.findByText("Signed in");
    expect(screen.queryByRole("button", { name: "All workspaces" })).toBeNull();
    expect(listAudit.mock.calls[0][0]).not.toContain("workspace=");
  });
});

describe("the retention card", () => {
  it("lets a deployment admin change the retention", async () => {
    setAuditRetention.mockResolvedValue({
      ...settings,
      retention: { ...settings.retention, days: 730, source: "app" },
    });
    render(<AuditTrail />);
    const input = await screen.findByLabelText("Keep for (days)");
    fireEvent.change(input, { target: { value: "730" } });
    fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
    await waitFor(() => expect(setAuditRetention).toHaveBeenCalledWith(730));
    expect(await screen.findByText("730 days")).toBeInTheDocument();
  });

  it("is read-only for a workspace admin", async () => {
    currentUser = { ...currentUser, isDeploymentAdmin: false };
    getAuditSettings.mockResolvedValue({ ...settings, canChange: false, stdout: true });
    render(<AuditTrail />);
    expect(await screen.findByTestId("audit-retention")).toHaveTextContent("365 days");
    expect(screen.getByTestId("audit-stdout")).toHaveTextContent("JSON line");
    expect(screen.queryByLabelText("Keep for (days)")).toBeNull();
    expect(screen.getByText("A deployment admin changes how long it is kept.")).toBeInTheDocument();
  });
});
