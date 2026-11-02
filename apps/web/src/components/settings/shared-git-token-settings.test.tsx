import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getDeploymentSettings: vi.fn(),
  getSharedGitToken: vi.fn(),
  updateSharedGitToken: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast }));

import { SharedGitTokenSettings, textToRules } from "./shared-git-token-settings";

const settings = (canEdit = true) => ({
  workspaceCreation: { value: "everyone", source: "environment", environment: "everyone" },
  canEdit,
  mayCreateWorkspace: true,
});

const off = { value: false, source: "environment", environment: false, repos: [] };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SharedGitTokenSettings", () => {
  it("is not shown to someone who isn't a deployment admin", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings(false));
    const { container } = render(<SharedGitTokenSettings />);
    await waitFor(() => expect(api.getDeploymentSettings).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    // Nor asked for the allowlist.
    expect(api.getSharedGitToken).not.toHaveBeenCalled();
  });

  it("follows the deployment (every repo) until a deployment admin turns it on, and can go back", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.getSharedGitToken.mockResolvedValue(off);
    api.updateSharedGitToken.mockResolvedValue({
      value: true,
      source: "app",
      environment: false,
      repos: [],
    });
    render(<SharedGitTokenSettings />);
    const follow = await screen.findByRole("button", {
      name: "Follow the deployment (every repo)",
    });
    expect(follow.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Allowed repos only" }));
    await waitFor(() =>
      expect(api.updateSharedGitToken).toHaveBeenCalledWith({ restricted: true }),
    );

    api.updateSharedGitToken.mockResolvedValue(off);
    fireEvent.click(
      await screen.findByRole("button", { name: "Follow the deployment (every repo)" }),
    );
    await waitFor(() =>
      expect(api.updateSharedGitToken).toHaveBeenLastCalledWith({ restricted: null }),
    );
  });

  it("shows the allowlist one line per entry and saves the edited lines", async () => {
    const on = {
      value: true,
      source: "app",
      environment: false,
      repos: [{ workspace: "platform", pattern: "gitlab.example.com/platform/*" }],
    };
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.getSharedGitToken.mockResolvedValue(on);
    api.updateSharedGitToken.mockResolvedValue(on);
    render(<SharedGitTokenSettings />);
    const area = (await screen.findByLabelText("Allowed repositories")) as HTMLTextAreaElement;
    expect(area.value).toBe("platform gitlab.example.com/platform/*");
    const save = screen.getByRole("button", { name: "Save allowed repositories" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(area, {
      target: {
        value:
          "platform gitlab.example.com/platform/*\n# a comment\n\nteam-a gitlab.example.com/team-a/app",
      },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.updateSharedGitToken).toHaveBeenCalledWith({
        repos: [
          { workspace: "platform", pattern: "gitlab.example.com/platform/*" },
          { workspace: "team-a", pattern: "gitlab.example.com/team-a/app" },
        ],
      }),
    );
  });

  it("refuses a malformed line without saving, and shows the API's refusal", async () => {
    api.getDeploymentSettings.mockResolvedValue(settings());
    api.getSharedGitToken.mockResolvedValue(off);
    render(<SharedGitTokenSettings />);
    const area = await screen.findByLabelText("Allowed repositories");
    fireEvent.change(area, { target: { value: "gitlab.example.com/team-a/app" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allowed repositories" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(api.updateSharedGitToken).not.toHaveBeenCalled();

    api.updateSharedGitToken.mockRejectedValue(new Error('No workspace "nope"'));
    fireEvent.change(area, { target: { value: "nope gitlab.example.com/team-a/app" } });
    fireEvent.click(screen.getByRole("button", { name: "Save allowed repositories" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenLastCalledWith("Couldn't save", {
        description: 'No workspace "nope"',
      }),
    );
  });
});

describe("textToRules", () => {
  it("skips blank and comment lines and reports lines that aren't two words", () => {
    expect(textToRules("a x/y/z\n\n# c\nbad\n b  h/g/* ")).toEqual({
      rules: [
        { workspace: "a", pattern: "x/y/z" },
        { workspace: "b", pattern: "h/g/*" },
      ],
      bad: ["bad"],
    });
  });
});
