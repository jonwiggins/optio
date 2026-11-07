import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const getSecretSharing = vi.fn();
const setSecretSharing = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    getSecretSharing: (...a: unknown[]) => getSecretSharing(...a),
    setSecretSharing: (...a: unknown[]) => setSecretSharing(...a),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ShareSecretForm } from "./share-secret-form";
import { ConnectionRow, isDeploymentSecretEntry } from "./connections-list";
import { entrySubtext } from "@/lib/connections";
import type { WorkEnvironmentEntry } from "@optio/shared";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function overview(allApplies: boolean, all = false, workspaceIds: string[] = [A]) {
  return {
    allApplies,
    secrets: [{ name: "REGISTRY_TOKEN", all, workspaceIds }],
    workspaces: [
      { id: A, name: "Team A", slug: "team-a" },
      { id: B, name: "Team B", slug: "team-b" },
    ],
  };
}

const SECRET: WorkEnvironmentEntry = {
  kind: "secret",
  id: "REGISTRY_TOKEN",
  name: "REGISTRY_TOKEN",
  detail: "Secret",
  icon: null,
  parts: ["credentials"],
  providerSlug: null,
  providerName: "Secret",
  enabled: true,
  scope: "global",
  default: false,
  ownerUserId: null,
};

beforeEach(() => {
  getSecretSharing.mockReset();
  setSecretSharing.mockReset().mockResolvedValue({});
});
afterEach(() => cleanup());

describe("ShareSecretForm", () => {
  it("starts from who it is shared with and saves the chosen workspaces", async () => {
    getSecretSharing.mockResolvedValue(overview(false));
    const onSaved = vi.fn();
    render(<ShareSecretForm name="REGISTRY_TOKEN" onClose={vi.fn()} onSaved={onSaved} />);
    const teamA = await screen.findByLabelText("Team A");
    expect(teamA).toBeChecked();
    expect(screen.getByLabelText("Team B")).not.toBeChecked();
    // Anyone may create a workspace here: "every workspace" is off limits.
    expect(screen.getByLabelText(/Every workspace/)).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Team B"));
    fireEvent.click(teamA);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(setSecretSharing).toHaveBeenCalledWith("REGISTRY_TOKEN", {
        all: false,
        workspaceIds: [B],
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("shares with every workspace when workspace creation is limited", async () => {
    getSecretSharing.mockResolvedValue(overview(true, false, []));
    render(<ShareSecretForm name="REGISTRY_TOKEN" onClose={vi.fn()} onSaved={vi.fn()} />);
    const every = await screen.findByLabelText(/Every workspace/);
    expect(every).not.toBeDisabled();
    fireEvent.click(every);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(setSecretSharing).toHaveBeenCalledWith("REGISTRY_TOKEN", {
        all: true,
        workspaceIds: [],
      }),
    );
  });
});

describe("a deployment secret's row", () => {
  const row = (entry: WorkEnvironmentEntry, isDeploymentAdmin: boolean) =>
    render(
      <ConnectionRow
        entry={entry}
        viewerId="u1"
        isAdmin
        isDeploymentAdmin={isDeploymentAdmin}
        onChanged={vi.fn()}
        onEditConnection={vi.fn()}
      />,
    );

  it("offers a deployment admin Share with workspaces", () => {
    expect(isDeploymentSecretEntry(SECRET)).toBe(true);
    expect(isDeploymentSecretEntry({ ...SECRET, ownerUserId: "u1" })).toBe(false);
    expect(isDeploymentSecretEntry({ ...SECRET, scope: "repo" })).toBe(false);
    row(SECRET, true);
    fireEvent.click(screen.getByRole("button", { name: "Actions for REGISTRY_TOKEN" }));
    expect(screen.getByRole("menuitem", { name: "Share with workspaces" })).toBeInTheDocument();
  });

  it("shows a workspace admin a shared secret as the deployment's, with nothing to change", () => {
    const shared = { ...SECRET, shared: true };
    expect(entrySubtext(shared, "u1")).toBe("Shared by the deployment · credentials only · Secret");
    row(shared, false);
    expect(screen.getByText(/Shared by the deployment/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Actions for REGISTRY_TOKEN" })).toBeNull();
  });
});
