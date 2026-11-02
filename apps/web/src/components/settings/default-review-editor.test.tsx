import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const currentUser = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

const api = vi.hoisted(() => ({
  getReviewDefault: vi.fn(),
  getOptioSettings: vi.fn(),
  saveReviewDefault: vi.fn(),
  updateOptioSettings: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// The picker loads the agent catalog itself; here it only reports what it was given.
vi.mock("@/components/review-agent-picker", () => ({
  ReviewAgentPicker: ({ agentType, model }: { agentType: string; model: string }) => (
    <div data-testid="picker">{`${agentType}/${model}`}</div>
  ),
}));

import { DefaultReviewEditor } from "./default-review-editor";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentUser.isAdmin = true;
});

describe("DefaultReviewEditor", () => {
  it("shows only the defaults Save stores, and stores each of them", async () => {
    api.getReviewDefault.mockResolvedValue({ template: "Review {{PR_NUMBER}}" });
    api.getOptioSettings.mockResolvedValue({
      settings: { defaultReviewAgentType: "codex", defaultReviewModel: "gpt-5" },
    });
    api.saveReviewDefault.mockResolvedValue({ ok: true });
    api.updateOptioSettings.mockResolvedValue({ settings: {} });
    render(<DefaultReviewEditor />);

    expect((await screen.findByTestId("picker")).textContent).toBe("codex/gpt-5");
    // Nothing on the server keeps a workspace-wide trigger, test command,
    // context window, effort or thinking for reviews: the card mustn't offer them.
    for (const label of ["Test command", "Effort", "Context window", "Thinking", "Starts"]) {
      expect(screen.queryByText(label)).toBeNull();
    }

    fireEvent.change(screen.getByLabelText("Review prompt"), {
      target: { value: "Review carefully" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateOptioSettings).toHaveBeenCalled());
    expect(api.saveReviewDefault).toHaveBeenCalledWith("Review carefully");
    expect(api.updateOptioSettings).toHaveBeenCalledWith({
      defaultReviewAgentType: "codex",
      defaultReviewModel: "gpt-5",
    });
  });

  // Both saves take a workspace admin; a member (a deployment admin included)
  // used to fill the form in and get a 403 back.
  it("is read-only for someone who isn't a workspace admin", async () => {
    currentUser.isAdmin = false;
    api.getReviewDefault.mockResolvedValue({ template: "Review" });
    api.getOptioSettings.mockResolvedValue({ settings: {} });
    render(<DefaultReviewEditor />);
    const save = await screen.findByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Only a workspace admin changes these defaults")).toBeTruthy();
  });
});
