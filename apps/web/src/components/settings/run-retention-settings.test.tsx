import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getDeploymentSettings: vi.fn(),
  getRunRetention: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));

import { RunRetentionSettings } from "./run-retention-settings";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RunRetentionSettings", () => {
  it("is not shown to someone who isn't a deployment admin", async () => {
    api.getDeploymentSettings.mockResolvedValue({ canEdit: false });
    const { container } = render(<RunRetentionSettings />);
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(api.getRunRetention).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("says logs are kept forever when the deployment sets no retention", async () => {
    api.getDeploymentSettings.mockResolvedValue({ canEdit: true });
    api.getRunRetention.mockResolvedValue({ runLogsDays: null });
    render(<RunRetentionSettings />);
    expect(await screen.findByText("Kept forever")).toBeTruthy();
    expect(screen.getByTestId("run-retention").textContent).toContain("until the run is deleted");
  });

  it("shows the days when the deployment sets a retention", async () => {
    api.getDeploymentSettings.mockResolvedValue({ canEdit: true });
    api.getRunRetention.mockResolvedValue({ runLogsDays: 90 });
    render(<RunRetentionSettings />);
    expect(await screen.findByText("Deleted after 90 days")).toBeTruthy();
    expect(screen.getByTestId("run-retention").textContent).toContain("more than 90 days ago");
  });
});
