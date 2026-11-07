import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const currentUser = vi.hoisted(() => ({ isAdmin: false, isDeploymentAdmin: false, loaded: true }));
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

const api = vi.hoisted(() => ({
  listSecrets: vi.fn(),
  createSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { DeploymentSecrets } from "./deployment-secrets";

const secret = {
  id: "s1",
  name: "ANTHROPIC_API_KEY",
  scope: "global",
  ownerUserId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function shown(who: { isAdmin: boolean; isDeploymentAdmin: boolean }) {
  Object.assign(currentUser, who);
  api.listSecrets.mockResolvedValue({ secrets: [secret] });
  render(<DeploymentSecrets />);
  await screen.findByText("ANTHROPIC_API_KEY");
  return {
    add: screen.queryByRole("button", { name: /add/i }),
    remove: screen.queryByRole("button", { name: "Delete ANTHROPIC_API_KEY" }),
  };
}

// The API takes a deployment admin for deployment secrets (routes/secrets.ts),
// whatever their role in the current workspace.
describe("DeploymentSecrets", () => {
  it("lets a deployment admin who is a member of the workspace add and delete them", async () => {
    const { add, remove } = await shown({ isAdmin: false, isDeploymentAdmin: true });
    expect(add).not.toBeNull();
    expect(remove).not.toBeNull();
  });

  it("offers a workspace admin who isn't a deployment admin no change the server would refuse", async () => {
    const { add, remove } = await shown({ isAdmin: true, isDeploymentAdmin: false });
    expect(add).toBeNull();
    expect(remove).toBeNull();
  });
});
