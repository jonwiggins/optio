import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { featuresFromEnv } from "@optio/shared/features";
let features = featuresFromEnv({});
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
afterEach(() => {
  cleanup();
  features = featuresFromEnv({});
});
async function openGitStep() {
  render(<SetupPage />);
  const next = screen.getByRole("button", { name: /Get Started/ });
  await waitFor(() => expect(next).not.toBeDisabled());
  fireEvent.click(next);
  await screen.findByRole("heading", { name: "Git Provider" });
}
describe("setup git-platform allowlist", () => {
  it("keeps all existing provider choices by default", async () => {
    await openGitStep();
    expect(screen.getByRole("button", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GitLab" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /CodeCommit/ })).toBeInTheDocument();
  });
  it("shows only GitLab when the deployment narrows that list", async () => {
    features = featuresFromEnv({ OPTIO_GIT_PLATFORMS: "gitlab" });
    await openGitStep();
    expect(screen.getByRole("button", { name: "GitLab" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "GitHub" })).toBeNull();
    expect(screen.queryByRole("button", { name: /CodeCommit/ })).toBeNull();
    expect(screen.queryByPlaceholderText(/ghp_/)).toBeNull();
  });
});
