import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

// "Adding a repo only shows GitHub": under the restricted deployment the Add repository
// page lists the person's GitLab projects and validates through GitLab.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/repos/new",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const browseRepos = vi.fn();
const browseGitHubRepos = vi.fn();
const validateRepo = vi.fn();
const listSecrets = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getOptioSettings: () => Promise.resolve({ settings: null }),
    listSecrets: (...a: unknown[]) => listSecrets(...a),
    browseRepos: (...a: unknown[]) => browseRepos(...a),
    browseGitHubRepos: (...a: unknown[]) => browseGitHubRepos(...a),
    validateRepo: (...a: unknown[]) => validateRepo(...a),
  },
}));

let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

import NewRepoPage from "./page";

beforeEach(() => {
  browseRepos.mockReset().mockResolvedValue({
    repos: [
      {
        fullName: "platform/optio",
        cloneUrl: "https://gitlab.example.com/platform/optio.git",
        htmlUrl: "https://gitlab.example.com/platform/optio",
        defaultBranch: "develop",
        isPrivate: true,
        description: null,
        pushedAt: null,
      },
    ],
    platform: "gitlab",
    host: "gitlab.example.com",
  });
  browseGitHubRepos.mockReset().mockResolvedValue({
    repos: [],
    page: 1,
    perPage: 20,
    hasMore: false,
  });
  validateRepo.mockReset();
  listSecrets.mockReset().mockResolvedValue({ secrets: [] });
});

afterEach(() => {
  cleanup();
  features = featuresFromEnv({});
});

describe("Add repository under the default deployment", () => {
  it("keeps the GitHub browser by default", async () => {
    render(<NewRepoPage />);
    expect(await screen.findByLabelText("Search accessible repositories")).toBeInTheDocument();
    expect(screen.queryByLabelText("Search GitLab projects")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("https://github.com/owner/repo")).toBeInTheDocument();
    await waitFor(() => expect(browseGitHubRepos).toHaveBeenCalled());
    expect(browseRepos).not.toHaveBeenCalled();
  });
});

describe("Add repository with GitHub and GitLab offered (full profile)", () => {
  beforeEach(() => {
    listSecrets.mockResolvedValue({ secrets: [{ name: "GITLAB_TOKEN", scope: "user" }] });
  });

  it("shows no switch until a GitLab is set up", async () => {
    listSecrets.mockResolvedValue({ secrets: [{ name: "GITHUB_TOKEN", scope: "global" }] });
    render(<NewRepoPage />);
    expect(await screen.findByLabelText("Search accessible repositories")).toBeInTheDocument();
    await waitFor(() => expect(listSecrets).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Git platform" })).not.toBeInTheDocument();
  });

  it("leaves a pasted URL to decide on the default GitHub tab", async () => {
    validateRepo.mockResolvedValue({
      valid: true,
      repo: { fullName: "group/project", defaultBranch: "main", isPrivate: true },
    });
    render(<NewRepoPage />);
    await screen.findByRole("group", { name: "Git platform" });
    const url = screen.getByPlaceholderText("https://github.com/owner/repo");
    fireEvent.change(url, { target: { value: "https://gitlab.example.org/group/sub/project" } });
    fireEvent.click(screen.getByRole("button", { name: /Validate/ }));
    await waitFor(() =>
      expect(validateRepo).toHaveBeenCalledWith(
        "https://gitlab.example.org/group/sub/project",
        undefined,
        undefined,
      ),
    );
  });

  it("switches the browser to GitLab's projects and validates through GitLab", async () => {
    validateRepo.mockResolvedValue({
      valid: true,
      repo: { fullName: "team/app", defaultBranch: "main", isPrivate: true },
    });
    render(<NewRepoPage />);
    const group = await screen.findByRole("group", { name: "Git platform" });
    expect(group).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "GitLab" }));

    expect(await screen.findByLabelText("Search GitLab projects")).toBeInTheDocument();
    expect(screen.queryByLabelText("Search accessible repositories")).not.toBeInTheDocument();
    await waitFor(() => expect(browseRepos).toHaveBeenCalled());

    const url = screen.getByPlaceholderText("https://gitlab.example.com/group/project");
    fireEvent.change(url, { target: { value: "https://git.example.com/team/app" } });
    fireEvent.click(screen.getByRole("button", { name: /Validate/ }));
    await waitFor(() =>
      expect(validateRepo).toHaveBeenCalledWith(
        "https://git.example.com/team/app",
        undefined,
        "gitlab",
      ),
    );
  });
});

describe("Add repository under the restricted deployment", () => {
  it("lists GitLab projects instead of GitHub's, and picking one fills the repo", async () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    render(<NewRepoPage />);
    expect(await screen.findByLabelText("Search GitLab projects")).toBeInTheDocument();
    expect(screen.queryByLabelText("Search accessible repositories")).not.toBeInTheDocument();
    expect(browseGitHubRepos).not.toHaveBeenCalled();
    expect(screen.queryByText(/GitHub/)).not.toBeInTheDocument();
    // One platform: no switch.
    expect(screen.queryByRole("group", { name: "Git platform" })).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("https://gitlab.example.com/group/project"),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("option", { name: /platform\/optio/ }));
    expect(screen.getByRole("option", { name: /platform\/optio/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
