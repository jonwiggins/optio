import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const browse = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { browseRepos: (...args: unknown[]) => browse(...args) },
}));

import { GitLabRepoBrowser } from "./gitlab-repo-browser";

const project = (fullName: string, extra: Record<string, unknown> = {}) => ({
  fullName,
  cloneUrl: `https://gitlab.example.com/${fullName}.git`,
  htmlUrl: `https://gitlab.example.com/${fullName}`,
  defaultBranch: "main",
  isPrivate: true,
  description: null,
  pushedAt: null,
  ...extra,
});

// Braces: a function returned from beforeEach is a teardown vitest would call.
beforeEach(() => {
  browse.mockReset();
});
afterEach(() => cleanup());

describe("GitLabRepoBrowser", () => {
  it("lists the GitLab projects the token is a member of and hands the picked one up", async () => {
    browse.mockResolvedValue({
      repos: [project("platform/tools/optio", { description: "Agents" }), project("me/notes")],
      platform: "gitlab",
      host: "gitlab.example.com",
    });
    const onPick = vi.fn();
    render(<GitLabRepoBrowser selected={null} onPick={onPick} />);

    fireEvent.click(await screen.findByRole("option", { name: /platform\/tools\/optio/ }));
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        fullName: "platform/tools/optio",
        htmlUrl: "https://gitlab.example.com/platform/tools/optio",
      }),
    );
    expect(browse).toHaveBeenCalledWith({ q: undefined, platform: "gitlab" });
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("searches GitLab as you type", async () => {
    browse
      .mockResolvedValueOnce({ repos: [project("a/one")], platform: "gitlab", host: "g" })
      .mockResolvedValueOnce({ repos: [project("team/payroll")], platform: "gitlab", host: "g" });
    render(<GitLabRepoBrowser selected={null} onPick={vi.fn()} />);
    await screen.findByRole("option", { name: /a\/one/ });

    fireEvent.change(screen.getByLabelText("Search GitLab projects"), {
      target: { value: "pay" },
    });
    await screen.findByRole("option", { name: /team\/payroll/ });
    expect(browse).toHaveBeenLastCalledWith({ q: "pay", platform: "gitlab" });
    expect(screen.queryByRole("option", { name: /a\/one/ })).toBeNull();
  });

  it("marks the selected project", async () => {
    browse.mockResolvedValue({ repos: [project("a/one")], platform: "gitlab", host: "g" });
    render(<GitLabRepoBrowser selected="a/one" onPick={vi.fn()} />);
    const option = await screen.findByRole("option", { name: /a\/one/ });
    expect(option).toHaveAttribute("aria-selected", "true");
  });

  it("shows why the list is empty (no token)", async () => {
    browse.mockResolvedValue({
      repos: [],
      platform: "gitlab",
      host: "gitlab.example.com",
      error: "No GitLab token — add your own GITLAB_TOKEN under Settings",
    });
    render(<GitLabRepoBrowser selected={null} onPick={vi.fn()} />);
    expect(await screen.findByText(/No GitLab token/)).toBeInTheDocument();
  });

  it("survives a failed request", async () => {
    browse.mockImplementation(() => Promise.reject(new Error("network")));
    render(<GitLabRepoBrowser selected={null} onPick={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText("Could not list GitLab projects")).toBeInTheDocument(),
    );
  });
});
