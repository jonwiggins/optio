import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getDeploymentSettings: vi.fn(),
  updateDeploymentSettings: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const reload = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-deployment-switches", () => ({
  useDeploymentSwitchesStore: { getState: () => ({ reload }) },
}));

import { DeploymentSwitchesSettings } from "./deployment-switches-settings";

const off = { value: false, source: "environment", environment: false } as const;
const settings = (over: Record<string, unknown> = {}) => ({
  workspaceCreation: { value: "everyone", source: "environment", environment: "everyone" },
  teams: off,
  mergeConfirmation: off,
  onboarding: off,
  canEdit: true,
  mayCreateWorkspace: true,
  ...over,
});

beforeEach(() => {
  api.getDeploymentSettings.mockReset();
  api.updateDeploymentSettings.mockReset();
  reload.mockReset();
});
afterEach(() => cleanup());

describe("DeploymentSwitchesSettings: the getting-started guide", () => {
  it("is off by default and a deployment admin turns it on", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.updateDeploymentSettings.mockResolvedValue(
      settings({ onboarding: { value: true, source: "app", environment: false } }),
    );
    render(<DeploymentSwitchesSettings />);

    const card = await screen.findByTestId("deployment-switch-onboarding");
    const group = within(card).getByRole("group", { name: "Show the getting-started guide" });
    expect(screen.getByText("Getting-started guide")).toBeInTheDocument();
    expect(
      within(group).getByRole("button", { name: /Follow the deployment \(off\)/ }),
    ).toBeTruthy();

    fireEvent.click(within(group).getByRole("button", { name: "On" }));
    await waitFor(() =>
      expect(api.updateDeploymentSettings).toHaveBeenCalledWith({ onboarding: true }),
    );
    // The Overview's checklist and the Help menu follow at once.
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it("shows nothing to someone who isn't a deployment admin", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings({ canEdit: false }));
    const { container } = render(<DeploymentSwitchesSettings />);
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
