import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const browse = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { browseGitHubRepos: (...args: unknown[]) => browse(...args) },
}));

import { GitHubRepoBrowser } from "./github-repo-browser";

const repo = (fullName: string, extra: Record<string, unknown> = {}) => ({
  fullName,
  cloneUrl: `https://github.com/${fullName}.git`,
  htmlUrl: `https://github.com/${fullName}`,
  defaultBranch: "main",
  isPrivate: false,
  description: null,
  pushedAt: null,
  ...extra,
});

beforeEach(() => browse.mockReset());
afterEach(() => cleanup());

describe("GitHubRepoBrowser (#623)", () => {
  it("lists accessible repos and hands the picked one to the parent", async () => {
    browse.mockResolvedValue({
      repos: [repo("acme/api", { isPrivate: true }), repo("me/dotfiles")],
      page: 1,
      perPage: 20,
      hasMore: false,
    });
    const onPick = vi.fn();
    render(<GitHubRepoBrowser selected={null} onPick={onPick} />);

    fireEvent.click(await screen.findByRole("option", { name: /acme\/api/ }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ fullName: "acme/api" }));
    expect(browse).toHaveBeenCalledWith({ q: undefined, page: 1, perPage: 20 });
  });

  it("searches as you type and pages with Load more", async () => {
    browse
      .mockResolvedValueOnce({ repos: [repo("a/one")], page: 1, perPage: 20, hasMore: false })
      .mockResolvedValueOnce({ repos: [repo("acme/pay")], page: 1, perPage: 20, hasMore: true })
      .mockResolvedValueOnce({
        repos: [repo("acme/payroll")],
        page: 2,
        perPage: 20,
        hasMore: false,
      });
    render(<GitHubRepoBrowser selected={null} onPick={vi.fn()} />);
    await screen.findByRole("option", { name: /a\/one/ });

    fireEvent.change(screen.getByLabelText("Search accessible repositories"), {
      target: { value: "pay" },
    });
    await screen.findByRole("option", { name: /acme\/pay/ });
    expect(browse).toHaveBeenLastCalledWith({ q: "pay", page: 1, perPage: 20 });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByRole("option", { name: /acme\/payroll/ });
    expect(browse).toHaveBeenLastCalledWith({ q: "pay", page: 2, perPage: 20 });
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("shows the server's reason when nothing can be listed", async () => {
    browse.mockResolvedValue({
      repos: [],
      page: 1,
      perPage: 20,
      hasMore: false,
      error: "No GitHub credentials configured",
    });
    render(<GitHubRepoBrowser selected={null} onPick={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText("No GitHub credentials configured")).toBeInTheDocument(),
    );
  });
});
