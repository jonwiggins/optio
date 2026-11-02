import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getDeploymentSettings: vi.fn(),
  searchCredentialUse: vi.fn(),
  exportCredentialUse: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";
import { CredentialUseSearch } from "./credential-use-search";

const row = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  runKind: "task",
  runId: "11111111-2222-3333-4444-555555555555",
  workspaceId: "ws-1",
  workspaceName: "Payments",
  userId: "u-1",
  userName: "Dana",
  userEmail: "dana@example.test",
  repoUrl: "https://gitlab.example.test/pay/core",
  kind: "git-token",
  scope: "workspace",
  name: "GITLAB_TOKEN",
  credentialId: "c-1",
  host: "gitlab.example.test",
  fingerprint: "0123456789abcdef",
  usedAt: "2026-10-30T12:00:00.000Z",
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CredentialUseSearch", () => {
  it("is not shown to someone who isn't a deployment admin", async () => {
    api.getDeploymentSettings.mockResolvedValue({ canEdit: false });
    const { container } = render(<CredentialUseSearch />);
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("searches by a pasted value and a time range and lists the runs with links", async () => {
    api.getDeploymentSettings.mockResolvedValue({ canEdit: true });
    api.searchCredentialUse.mockResolvedValue({
      rows: [
        row(),
        row({
          id: "row-2",
          runKind: "review",
          runId: "99999999-0000-0000-0000-000000000000",
          userId: null,
          userName: null,
          userEmail: null,
        }),
      ],
      truncated: true,
      fingerprint: "0123456789abcdef",
    });
    render(<CredentialUseSearch />);
    const value = await screen.findByLabelText("Credential value");
    expect(value.getAttribute("type")).toBe("password");
    fireEvent.change(value, { target: { value: "leaked-value" } });
    fireEvent.change(screen.getByLabelText("Used from"), {
      target: { value: "2026-10-01T00:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(api.searchCredentialUse).toHaveBeenCalledTimes(1));
    const query = api.searchCredentialUse.mock.calls[0][0];
    expect(query.value).toBe("leaked-value");
    expect(query.name).toBeUndefined();
    expect(query.from).toBe(new Date("2026-10-01T00:00").toISOString());
    expect(query.to).toBeUndefined();

    const result = await screen.findByTestId("credential-use-result");
    expect(result.textContent).toContain("2 matches (more exist");
    expect(result.textContent).toContain("0123456789abcdef");
    expect(result.textContent).toContain("Payments");
    expect(result.textContent).toContain("Dana");
    expect(result.textContent).toContain("Organization");
    expect(result.textContent).toContain("git-token, workspace, gitlab.example.test");
    expect(screen.getByRole("link", { name: "Task 11111111" }).getAttribute("href")).toBe(
      "/tasks/11111111-2222-3333-4444-555555555555",
    );
    // A review run has no page of its own to link to.
    expect(screen.queryByRole("link", { name: /Review/ })).toBeNull();
    expect(result.textContent).toContain("Review 99999999");
    // The value is never shown back.
    expect(document.body.textContent).not.toContain("leaked-value");
  });

  it("searches by name and exports the same search as CSV", async () => {
    api.getDeploymentSettings.mockResolvedValue({ canEdit: true });
    api.exportCredentialUse.mockResolvedValue("usedAt,runKind\r\n");
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<CredentialUseSearch />);
    fireEvent.change(await screen.findByLabelText("Credential name"), {
      target: { value: " GITLAB_TOKEN " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() =>
      expect(api.exportCredentialUse).toHaveBeenCalledWith({
        name: "GITLAB_TOKEN",
        from: undefined,
        to: undefined,
      }),
    );
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:x");
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it("says when the search fails", async () => {
    api.getDeploymentSettings.mockResolvedValue({ canEdit: true });
    api.searchCredentialUse.mockRejectedValue(new Error("Forbidden"));
    render(<CredentialUseSearch />);
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't search", { description: "Forbidden" }),
    );
  });
});
