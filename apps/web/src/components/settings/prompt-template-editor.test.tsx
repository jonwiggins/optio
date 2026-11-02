import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const currentUser = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

const api = vi.hoisted(() => ({
  getEffectiveTemplate: vi.fn(),
  savePromptTemplate: vi.fn(),
  getBuiltinDefault: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { PromptTemplateEditor } from "./prompt-template-editor";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentUser.isAdmin = true;
});

describe("PromptTemplateEditor", () => {
  it("saves for a workspace admin, and says why when the server refuses", async () => {
    api.getEffectiveTemplate.mockResolvedValue({ template: "Do {{TASK_TITLE}}", autoMerge: false });
    api.savePromptTemplate.mockRejectedValue(
      new Error("Only a workspace admin changes the workspace's default prompts"),
    );
    render(<PromptTemplateEditor />);
    fireEvent.change(await screen.findByLabelText("Agent prompt"), {
      target: { value: "Do it well" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.savePromptTemplate).toHaveBeenCalledWith({
        template: "Do it well",
        autoMerge: false,
      }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Only a workspace admin changes the workspace's default prompts",
      ),
    );
  });

  // POST /api/prompt-templates takes a workspace admin for the workspace's
  // default; a member (a deployment admin included) got "Failed to save".
  it("is read-only for someone who isn't a workspace admin", async () => {
    currentUser.isAdmin = false;
    api.getEffectiveTemplate.mockResolvedValue({ template: "Do", autoMerge: false });
    render(<PromptTemplateEditor />);
    const save = await screen.findByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Only a workspace admin changes these defaults")).toBeTruthy();
  });
});
