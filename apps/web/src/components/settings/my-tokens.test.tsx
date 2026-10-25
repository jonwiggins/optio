import { featuresFromEnv } from "@optio/shared/features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GatewayMe } from "@/lib/api-client";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

let currentUser: any = {
  user: { id: "u1", displayName: "Jon", workspaceId: "ws", adminTeamIds: ["t1"] },
  userId: "u1",
  isAdmin: false,
  loaded: true,
};
vi.mock("@/hooks/use-current-user", () => ({ useCurrentUser: () => currentUser }));

let features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

const getMyGateway = vi.fn();
const setMyGatewayToken = vi.fn();
const createSecret = vi.fn();
const listSecrets = vi.fn();
const deleteSecret = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getMyGateway: () => getMyGateway(),
    setMyGatewayToken: (...a: unknown[]) => setMyGatewayToken(...a),
    createSecret: (...a: unknown[]) => createSecret(...a),
    listSecrets: (...a: unknown[]) => listSecrets(...a),
    deleteSecret: (...a: unknown[]) => deleteSecret(...a),
  },
}));

// The gateway's ways to a token (my-gateway-key.tsx): pasting only, as before
// Optio made keys; my-gateway-key.test.tsx covers the others.
vi.mock("@/lib/gateway-keys-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/gateway-keys-api")>()),
  gatewayKeysApi: {
    getMyKey: () =>
      Promise.resolve({
        gateway: { id: "g1", name: "LiteLLM" },
        modes: { personalPasted: true, optioIssued: false },
        canIssue: false,
        issued: null,
        defaults: { maxBudget: null, budgetDuration: "30d", keyDuration: null },
      }),
  },
}));

import { MyTokens } from "./my-tokens";
import { useGatewayStore } from "@/hooks/use-gateway";

const status: GatewayMe = {
  gateway: {
    id: "g1",
    name: "LiteLLM",
    baseUrl: "https://litellm.example.com",
    authHeader: "bearer",
    tokenSource: "personal",
    secretName: "ANTHROPIC_AUTH_TOKEN",
  },
  hasToken: false,
  keyInfo: null,
  teams: [
    { id: "t1", name: "Platform", hasToken: false },
    { id: "t2", name: "Data", hasToken: true },
  ],
  orgHasToken: false,
};

beforeEach(() => {
  getMyGateway.mockReset();
  setMyGatewayToken.mockReset();
  createSecret.mockReset();
  listSecrets.mockReset().mockResolvedValue({ secrets: [] });
  deleteSecret.mockReset().mockResolvedValue(undefined);
  useGatewayStore.getState().reset();
  features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
  currentUser = { ...currentUser, isAdmin: false };
});

afterEach(() => cleanup());

describe("Settings → My tokens", () => {
  it("shows the default gateway, whether you have a token, and stores one with its test result", async () => {
    getMyGateway.mockResolvedValue(status);
    setMyGatewayToken.mockResolvedValue({
      secretName: "ANTHROPIC_AUTH_TOKEN",
      test: { ok: true, modelCount: 3 },
    });
    render(<MyTokens />);
    expect(await screen.findByText("LiteLLM")).toBeInTheDocument();
    expect(screen.getByText("(https://litellm.example.com)")).toBeInTheDocument();
    expect(screen.getByText("ANTHROPIC_AUTH_TOKEN")).toBeInTheDocument();
    expect(screen.getAllByText("No token yet").length).toBeGreaterThan(0);

    const field = screen.getByPlaceholderText("Paste your token");
    fireEvent.change(field, { target: { value: " sk-me " } });
    getMyGateway.mockResolvedValue({ ...status, hasToken: true });
    fireEvent.click(screen.getAllByRole("button", { name: /save/i })[0]);
    await waitFor(() => expect(setMyGatewayToken).toHaveBeenCalledWith("sk-me"));
    expect(await screen.findByText("Works — sees 3 models")).toBeInTheDocument();
    // The status reloads so the chip moves.
    expect(await screen.findByText("Token stored")).toBeInTheDocument();
  });

  it("says when the gateway refused the token it stored", async () => {
    getMyGateway.mockResolvedValue(status);
    setMyGatewayToken.mockResolvedValue({
      secretName: "ANTHROPIC_AUTH_TOKEN",
      test: { ok: false, modelCount: 0, error: "401 from the gateway" },
    });
    render(<MyTokens />);
    await screen.findByText("LiteLLM");
    fireEvent.change(screen.getByPlaceholderText("Paste your token"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /save/i })[0]);
    expect(
      await screen.findByText("Stored, but the gateway refused it: 401 from the gateway"),
    ).toBeInTheDocument();
  });

  it("lets a team admin store the team's token, and reads the others' standing", async () => {
    getMyGateway.mockResolvedValue(status);
    createSecret.mockResolvedValue({ name: "ANTHROPIC_AUTH_TOKEN", scope: "team" });
    render(<MyTokens />);
    await screen.findByText("LiteLLM");
    // Platform (t1): the viewer administers it — a field. Data (t2): read-only.
    const platform = screen.getByTestId("team-token-t1");
    const data = screen.getByTestId("team-token-t2");
    expect(platform.querySelector("input")).not.toBeNull();
    expect(data.querySelector("input")).toBeNull();
    expect(data.textContent).toContain("Stored");
    expect(data.textContent).toContain("a team admin adds it");
    fireEvent.change(platform.querySelector("input")!, { target: { value: "sk-team" } });
    fireEvent.click(platform.querySelector("button")!);
    await waitFor(() =>
      expect(createSecret).toHaveBeenCalledWith({
        name: "ANTHROPIC_AUTH_TOKEN",
        value: "sk-team",
        scope: "team",
        teamId: "t1",
      }),
    );
    // Not an admin: the organization's token is read-only.
    expect(screen.getByTestId("org-token").querySelector("input")).toBeNull();
  });

  it("lets a workspace admin store the organization's token", async () => {
    currentUser = { ...currentUser, isAdmin: true };
    getMyGateway.mockResolvedValue(status);
    createSecret.mockResolvedValue({ name: "ANTHROPIC_AUTH_TOKEN", scope: "global" });
    render(<MyTokens />);
    await screen.findByText("LiteLLM");
    const org = screen.getByTestId("org-token");
    fireEvent.change(org.querySelector("input")!, { target: { value: "sk-org" } });
    fireEvent.click(org.querySelector("button")!);
    await waitFor(() =>
      expect(createSecret).toHaveBeenCalledWith({
        name: "ANTHROPIC_AUTH_TOKEN",
        value: "sk-org",
        scope: "global",
      }),
    );
  });

  it("says what's missing without a gateway under the restricted deployment, and keeps only the GitLab token in the default deployment", async () => {
    getMyGateway.mockResolvedValue({ ...status, gateway: null, teams: [] });
    const { unmount } = render(<MyTokens />);
    expect(await screen.findByText("No model gateway yet")).toBeInTheDocument();
    expect(screen.getByTestId("my-gitlab-token")).toBeInTheDocument();
    unmount();
    features = featuresFromEnv({});
    useGatewayStore.getState().reset();
    render(<MyTokens />);
    await waitFor(() => expect(useGatewayStore.getState().loaded).toBe(true));
    expect(screen.queryByText("No model gateway yet")).toBeNull();
    expect(screen.getByTestId("my-gitlab-token")).toBeInTheDocument();
  });

  it("stores your own GitLab token at user scope, and shows when one is stored", async () => {
    getMyGateway.mockResolvedValue(status);
    createSecret.mockResolvedValue({ name: "GITLAB_TOKEN", scope: "user" });
    render(<MyTokens />);
    await screen.findByText("LiteLLM");
    const gitlab = screen.getByTestId("my-gitlab-token");
    expect(gitlab.textContent).toContain("instead of the organization's token");
    listSecrets.mockResolvedValue({
      secrets: [{ id: "s1", name: "GITLAB_TOKEN", scope: "user", ownerUserId: "u1" }],
    });
    fireEvent.change(gitlab.querySelector("input")!, { target: { value: " glpat-abc " } });
    fireEvent.click(gitlab.querySelector("button")!);
    await waitFor(() =>
      expect(createSecret).toHaveBeenCalledWith({
        name: "GITLAB_TOKEN",
        value: "glpat-abc",
        scope: "user",
      }),
    );
    await waitFor(() => expect(gitlab.textContent).toContain("Stored"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deleteSecret).toHaveBeenCalledWith("GITLAB_TOKEN", "user"));
  });
});
