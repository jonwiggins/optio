import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const currentUser = vi.hoisted(() => ({
  isAdmin: false,
  isDeploymentAdmin: true,
  authDisabled: false,
}));
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

const api = vi.hoisted(() => ({
  getEffectiveTemplate: vi.fn(),
  savePromptTemplate: vi.fn(),
  getBuiltinDefault: vi.fn(),
  getReviewDefault: vi.fn(),
  getOptioSettings: vi.fn(),
  saveReviewDefault: vi.fn(),
  updateOptioSettings: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/review-agent-picker", () => ({
  ReviewAgentPicker: ({ agentType, model }: { agentType: string; model: string }) => (
    <div data-testid="picker">{`${agentType}/${model}`}</div>
  ),
}));

import { DefaultsScopeSwitch, DEPLOYMENT_ADMIN_ONLY } from "./defaults-scope";
import { PromptTemplateEditor } from "./prompt-template-editor";
import { DefaultReviewEditor } from "./default-review-editor";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.assign(currentUser, { isAdmin: false, isDeploymentAdmin: true, authDisabled: false });
});

describe("DefaultsScopeSwitch", () => {
  it("switches to the deployment defaults and says what they are", () => {
    const onChange = vi.fn();
    const { rerender } = render(<DefaultsScopeSwitch scope="workspace" onChange={onChange} />);
    expect(screen.getByText(/uses the deployment defaults/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deployment defaults" }));
    expect(onChange).toHaveBeenCalledWith("deployment");
    rerender(<DefaultsScopeSwitch scope="deployment" onChange={onChange} />);
    expect(screen.getByText(/until that workspace saves its own/)).toBeTruthy();
  });
});

describe("Agent prompt, deployment defaults", () => {
  it("reads and saves the deployment's for a deployment admin who isn't a workspace admin", async () => {
    api.getEffectiveTemplate.mockResolvedValue({
      template: "Built in",
      autoMerge: false,
      source: "builtin",
    });
    api.savePromptTemplate.mockResolvedValue({ ok: true });
    render(<PromptTemplateEditor scope="deployment" />);
    fireEvent.change(await screen.findByLabelText("Agent prompt"), {
      target: { value: "For everyone" },
    });
    expect(api.getEffectiveTemplate).toHaveBeenCalledWith(undefined, "deployment");
    expect(screen.getByText("Built-in default: no deployment default saved yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.savePromptTemplate).toHaveBeenCalledWith({
        template: "For everyone",
        autoMerge: false,
        scope: "deployment",
      }),
    );
    expect(await screen.findByText("Deployment default")).toBeTruthy();
  });

  it("is read-only for a workspace admin who isn't a deployment admin", async () => {
    Object.assign(currentUser, { isAdmin: true, isDeploymentAdmin: false });
    api.getEffectiveTemplate.mockResolvedValue({ template: "Dep", autoMerge: false });
    render(<PromptTemplateEditor scope="deployment" />);
    const save = await screen.findByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(DEPLOYMENT_ADMIN_ONLY)).toBeTruthy();
  });
});

describe("where a workspace's value comes from", () => {
  it("says a workspace with nothing of its own uses the deployment defaults", async () => {
    Object.assign(currentUser, { isAdmin: true, isDeploymentAdmin: false });
    api.getEffectiveTemplate.mockResolvedValue({
      template: "Dep",
      autoMerge: false,
      source: "deployment",
    });
    render(<PromptTemplateEditor />);
    expect(
      await screen.findByText("From the deployment defaults until this workspace saves its own"),
    ).toBeTruthy();
    expect(api.getEffectiveTemplate).toHaveBeenCalledWith(undefined, "workspace");
  });

  it("says nothing with sign-in off, where there is one scope", async () => {
    Object.assign(currentUser, { isAdmin: true, authDisabled: true });
    api.getEffectiveTemplate.mockResolvedValue({
      template: "Dep",
      autoMerge: false,
      source: "deployment",
    });
    render(<PromptTemplateEditor />);
    await screen.findByLabelText("Agent prompt");
    expect(screen.queryByText(/deployment default/i)).toBeNull();
  });
});

describe("Code review, deployment defaults", () => {
  it("reads and saves both the deployment's reviewer and review prompt", async () => {
    api.getReviewDefault.mockResolvedValue({ template: "Dep review", source: "deployment" });
    api.getOptioSettings.mockResolvedValue({
      settings: { defaultReviewAgentType: "codex", defaultReviewModel: "gpt-5" },
      source: "deployment",
    });
    api.saveReviewDefault.mockResolvedValue({ ok: true });
    api.updateOptioSettings.mockResolvedValue({ settings: {} });
    render(<DefaultReviewEditor scope="deployment" />);
    expect((await screen.findByTestId("picker")).textContent).toBe("codex/gpt-5");
    expect(api.getReviewDefault).toHaveBeenCalledWith("deployment");
    expect(api.getOptioSettings).toHaveBeenCalledWith("deployment");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateOptioSettings).toHaveBeenCalled());
    expect(api.saveReviewDefault).toHaveBeenCalledWith("Dep review", "deployment");
    expect(api.updateOptioSettings).toHaveBeenCalledWith({
      defaultReviewAgentType: "codex",
      defaultReviewModel: "gpt-5",
      scope: "deployment",
    });
  });
});
