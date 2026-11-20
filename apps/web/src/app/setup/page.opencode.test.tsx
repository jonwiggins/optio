import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { featuresFromEnv } from "@optio/shared/features";
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features: featuresFromEnv({}), loaded: true }),
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
const createSecret = vi.fn().mockResolvedValue({});
vi.mock("@/lib/api-client", () => ({
  api: {
    getAuthProviders: vi
      .fn()
      .mockResolvedValue({ authDisabled: true, setupRequired: false, providers: [] }),
    getHealth: vi.fn().mockResolvedValue({ healthy: true }),
    getGitHubAppStatus: vi.fn().mockResolvedValue({ configured: true }),
    getAuthStatus: vi.fn().mockResolvedValue({ subscription: { available: false } }),
    createSecret: (...args: unknown[]) => createSecret(...args),
    listUserRepos: vi.fn().mockResolvedValue({ repos: [] }),
  },
}));
import SetupPage from "./page";
afterEach(cleanup);
async function openAgentStep() {
  render(<SetupPage />);
  const start = screen.getByRole("button", { name: /Get Started/ });
  await waitFor(() => expect(start).not.toBeDisabled());
  fireEvent.click(start);
  await screen.findByRole("heading", { name: "Git Provider" });
  const next = screen.getByRole("button", { name: /Continue/ });
  await waitFor(() => expect(next).not.toBeDisabled());
  fireEvent.click(next);
  await screen.findByRole("heading", { name: "Agent Configuration" });
}
describe("setup OpenCode Zen / Go key", () => {
  it("lets an OpenCode key alone finish the agent step and stores it as OPENCODE_API_KEY", async () => {
    await openAgentStep();
    const next = screen.getByRole("button", { name: /Continue/ });
    expect(next).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: /OpenCode Zen \/ Go API key/ }));
    fireEvent.change(screen.getByPlaceholderText("OpenCode API key"), {
      target: { value: " oc-test-key " },
    });
    await waitFor(() => expect(next).not.toBeDisabled());
    fireEvent.click(next);

    await waitFor(() =>
      expect(createSecret).toHaveBeenCalledWith({
        name: "OPENCODE_API_KEY",
        value: "oc-test-key",
        scope: "global",
      }),
    );
  });
});
