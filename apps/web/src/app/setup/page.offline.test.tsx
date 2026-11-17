import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { featuresFromEnv } from "@optio/shared/features";
const features = featuresFromEnv({});
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
vi.mock("@/lib/api-client", () => ({
  api: {
    getAuthProviders: vi
      .fn()
      .mockResolvedValue({ authDisabled: true, setupRequired: false, providers: [] }),
    getHealth: vi.fn().mockResolvedValue({ healthy: true }),
    getGitHubAppStatus: vi.fn().mockResolvedValue({ configured: false }),
  },
}));
import SetupPage from "./page";

// The offline UI (lib/offline-ui.ts): no link to a token page on a host
// outside the deployment.
afterEach(() => {
  cleanup();
  delete (window as any).__OPTIO_CONFIG;
});

async function openGitStep() {
  render(<SetupPage />);
  const next = screen.getByRole("button", { name: /Get Started/ });
  await waitFor(() => expect(next).not.toBeDisabled());
  fireEvent.click(next);
  await screen.findByRole("heading", { name: "Git Provider" });
}

describe("setup token links", () => {
  it("link to the GitHub and gitlab.com token pages by default", async () => {
    await openGitStep();
    expect(screen.getByRole("link", { name: /Create GitHub Personal Access Token/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "GitLab" }));
    expect(
      screen.getByRole("link", { name: /Create GitLab Personal Access Token/ }),
    ).toHaveAttribute("href", expect.stringMatching(/^https:\/\/gitlab\.com\//));
  });

  it("offline, leave out github.com and gitlab.com, and link to a GitLab host typed in", async () => {
    (window as any).__OPTIO_CONFIG = { offlineUi: true };
    await openGitStep();
    expect(screen.queryByRole("link", { name: /Create GitHub Personal Access Token/ })).toBeNull();
    expect(screen.getByPlaceholderText(/ghp_/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "GitLab" }));
    expect(screen.queryByRole("link", { name: /Create GitLab Personal Access Token/ })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("gitlab.com"), {
      target: { value: "gitlab.internal.example.com" },
    });
    expect(
      screen.getByRole("link", { name: /Create GitLab Personal Access Token/ }),
    ).toHaveAttribute("href", expect.stringMatching(/^https:\/\/gitlab\.internal\.example\.com\//));
  });
});
