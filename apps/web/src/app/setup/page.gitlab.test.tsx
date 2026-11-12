import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { featuresFromEnv } from "@optio/shared/features";

const features = featuresFromEnv({ OPTIO_GIT_PLATFORMS: "gitlab" });
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, loaded: true }),
}));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    user: null,
    loaded: true,
    authDisabled: true,
    isAdmin: true,
    canMutate: true,
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const api = vi.hoisted(() => ({
  getAuthProviders: vi.fn(),
  getHealth: vi.fn(),
  getGitHubAppStatus: vi.fn(),
  validateGitlabToken: vi.fn(),
  listGitlabRepos: vi.fn(),
  addWorkspaceGitLabServer: vi.fn(),
  createSecret: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));

import SetupPage from "./page";

beforeEach(() => {
  api.getAuthProviders.mockResolvedValue({
    authDisabled: true,
    setupRequired: false,
    providers: [],
  });
  api.getHealth.mockResolvedValue({ healthy: true });
  api.getGitHubAppStatus.mockResolvedValue({ configured: false });
  api.validateGitlabToken.mockResolvedValue({
    valid: true,
    user: { login: "team-bot", name: "Team Bot" },
  });
  api.listGitlabRepos.mockResolvedValue({ repos: [] });
  api.addWorkspaceGitLabServer.mockResolvedValue({ server: { host: "git.corp.example" } });
  api.createSecret.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function saveGitLab() {
  render(<SetupPage />);
  const start = screen.getByRole("button", { name: /Get Started/ });
  await waitFor(() => expect(start).not.toBeDisabled());
  fireEvent.click(start);
  await screen.findByRole("heading", { name: "Git Provider" });
  fireEvent.change(screen.getByPlaceholderText("gitlab.com"), {
    target: { value: "git.corp.example" },
  });
  fireEvent.change(screen.getByPlaceholderText("glpat-..."), {
    target: { value: "glpat-team" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Validate GitLab" }));
  await screen.findByText("team-bot");
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
}

describe("setup wizard's GitLab step", () => {
  it("saves the token as the workspace's own GitLab server, not a deployment secret", async () => {
    await saveGitLab();
    await waitFor(() =>
      expect(api.addWorkspaceGitLabServer).toHaveBeenCalledWith({
        host: "git.corp.example",
        token: "glpat-team",
        isDefault: true,
      }),
    );
    expect(api.createSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "GITLAB_TOKEN" }),
    );
    expect(api.createSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "GITLAB_HOST" }),
    );
  });

  it("with no workspace at all (sign-in off), saves the deployment's as before", async () => {
    api.addWorkspaceGitLabServer.mockRejectedValue(
      Object.assign(new Error("There is no workspace here"), {
        status: 400,
        details: "no_workspace",
      }),
    );
    await saveGitLab();
    await waitFor(() =>
      expect(api.createSecret).toHaveBeenCalledWith({ name: "GITLAB_TOKEN", value: "glpat-team" }),
    );
    expect(api.createSecret).toHaveBeenCalledWith({
      name: "GITLAB_HOST",
      value: "git.corp.example",
    });
  });

  it("doesn't fall back to the deployment when the workspace refuses the server", async () => {
    api.addWorkspaceGitLabServer.mockRejectedValue(
      Object.assign(
        new Error("git.corp.example isn't a GitLab server this deployment sends credentials to"),
        {
          status: 400,
        },
      ),
    );
    await saveGitLab();
    await waitFor(() => expect(api.addWorkspaceGitLabServer).toHaveBeenCalled());
    expect(api.createSecret).not.toHaveBeenCalled();
  });
});
