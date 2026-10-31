import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getDeploymentSettings: vi.fn(),
  updateDeploymentSettings: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { MergeConfirmationSettings } from "./merge-confirmation-settings";

const settings = (over: Record<string, unknown> = {}) => ({
  workspaceCreation: { value: "everyone", source: "environment", environment: "everyone" },
  mergeConfirmation: { value: false, source: "environment", environment: false },
  canEdit: true,
  mayCreateWorkspace: true,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MergeConfirmationSettings", () => {
  it("is not shown to someone who isn't a deployment admin", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings({ canEdit: false }));
    const { container } = render(<MergeConfirmationSettings />);
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("is off by default, turns on, and can follow the deployment again", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.updateDeploymentSettings.mockResolvedValue(
      settings({ mergeConfirmation: { value: true, source: "app", environment: false } }),
    );
    render(<MergeConfirmationSettings />);
    const follow = await screen.findByRole("button", { name: "Follow the deployment (off)" });
    expect(follow.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "On" }));
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenCalledWith({ mergeConfirmation: true }),
    );

    api.updateDeploymentSettings.mockResolvedValue(settings());
    fireEvent.click(await screen.findByRole("button", { name: "Follow the deployment (off)" }));
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenLastCalledWith({ mergeConfirmation: null }),
    );
  });
});
