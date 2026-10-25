import { featuresFromEnv } from "@optio/shared/features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GatewayMe } from "@/lib/api-client";
import type { MyGatewayKey } from "@/lib/gateway-keys-api";

// Settings → My tokens in the ways the gateway allows: pasted, made by Optio, or both.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({
    user: { id: "u1", displayName: "Bob", workspaceId: "ws", adminTeamIds: ["t1"] },
    userId: "u1",
    isAdmin: false,
    loaded: true,
  }),
}));

vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({
    features: featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
    gatewayOnly: true,
    loaded: true,
  }),
}));

const getMyGateway = vi.fn();
const setMyGatewayToken = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    getMyGateway: () => getMyGateway(),
    setMyGatewayToken: (...a: unknown[]) => setMyGatewayToken(...a),
    createSecret: vi.fn(),
    listSecrets: vi.fn().mockResolvedValue({ secrets: [] }),
    deleteSecret: vi.fn(),
  },
}));

const getMyKey = vi.fn();
const issueMyKey = vi.fn();
const rotateMyKey = vi.fn();
const revokeMyKey = vi.fn();
vi.mock("@/lib/gateway-keys-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/gateway-keys-api")>()),
  gatewayKeysApi: {
    getMyKey: () => getMyKey(),
    issueMyKey: () => issueMyKey(),
    rotateMyKey: () => rotateMyKey(),
    revokeMyKey: () => revokeMyKey(),
  },
}));

import { MyTokens } from "./my-tokens";
import { keyTermsLine } from "./my-gateway-key";
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
  teams: [{ id: "t1", name: "Platform", hasToken: false }],
  orgHasToken: false,
};

const defaults = { maxBudget: 25, budgetDuration: "30d", keyDuration: "90d" };

function keyStatus(patch: Partial<MyGatewayKey> = {}): MyGatewayKey {
  return {
    gateway: { id: "g1", name: "LiteLLM" },
    modes: { personalPasted: true, optioIssued: false },
    canIssue: false,
    issued: null,
    defaults,
    ...patch,
  };
}

const issued = {
  id: "k1",
  kind: "person" as const,
  keyAlias: "optio-bob",
  keyHint: "a1b2",
  models: ["qwen-internal"],
  maxBudget: 25,
  budgetDuration: "30d",
  expiresAt: null,
  createdAt: "2026-10-24T00:00:00.000Z",
  spendUsd: 4.5,
  budgetResetAt: null,
  checkedAt: "2026-10-24T01:00:00.000Z",
};

beforeEach(() => {
  getMyGateway.mockReset().mockResolvedValue(status);
  setMyGatewayToken.mockReset();
  getMyKey.mockReset();
  issueMyKey.mockReset();
  rotateMyKey.mockReset();
  revokeMyKey.mockReset();
  useGatewayStore.getState().reset();
});

afterEach(() => cleanup());

describe("Settings → My tokens: the gateway's ways to a token", () => {
  it("pasting only: the paste field, no Get my token", async () => {
    getMyKey.mockResolvedValue(keyStatus());
    render(<MyTokens />);
    expect(await screen.findByPlaceholderText("Paste your token")).toBeInTheDocument();
    await waitFor(() => expect(getMyKey).toHaveBeenCalled());
    expect(screen.queryByTestId("get-my-token")).toBeNull();
  });

  it("Optio makes keys only: Get my token makes one, no paste field, team admins pointed to the team", async () => {
    getMyKey.mockResolvedValue(
      keyStatus({ modes: { personalPasted: false, optioIssued: true }, canIssue: true }),
    );
    issueMyKey.mockResolvedValue({
      action: "issue",
      key: issued,
      secretName: "ANTHROPIC_AUTH_TOKEN",
      test: { ok: true, modelCount: 2 },
    });
    render(<MyTokens />);
    const button = await screen.findByTestId("get-my-token");
    expect(screen.queryByPlaceholderText("Paste your token")).toBeNull();
    expect(screen.getByText(/a budget of \$25\.00 per 30d, valid for 90d/)).toBeInTheDocument();
    // The team the viewer administers: no paste field, a pointer to the team's page.
    const team = screen.getByTestId("team-token-t1");
    expect(team.querySelector("input")).toBeNull();
    expect(team.textContent).toContain("made by Optio under Teams → Platform → Tokens");

    getMyGateway.mockResolvedValue({ ...status, hasToken: true });
    getMyKey.mockResolvedValue(
      keyStatus({ modes: { personalPasted: false, optioIssued: true }, canIssue: true, issued }),
    );
    fireEvent.click(button);
    await waitFor(() => expect(issueMyKey).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("my-issued-key")).toHaveTextContent("optio-bob");
    expect(screen.getByTestId("my-issued-key")).toHaveTextContent("…a1b2");
    expect(screen.getByTestId("my-issued-key")).toHaveTextContent("$4.50 of $25.00 per 30d spent");
    expect(await screen.findByText("Works — sees 2 models")).toBeInTheDocument();
  });

  it("both: the person may get one or paste their own", async () => {
    getMyKey.mockResolvedValue(
      keyStatus({ modes: { personalPasted: true, optioIssued: true }, canIssue: true }),
    );
    render(<MyTokens />);
    expect(await screen.findByTestId("get-my-token")).toBeEnabled();
    expect(
      screen.getByText("Or paste a key you got from the gateway yourself."),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Paste your token")).toBeInTheDocument();
    // The team the viewer administers keeps its paste field.
    expect(screen.getByTestId("team-token-t1").querySelector("input")).not.toBeNull();
  });

  it("says when an admin hasn't finished setting up the keys", async () => {
    getMyKey.mockResolvedValue(
      keyStatus({ modes: { personalPasted: false, optioIssued: true }, canIssue: false }),
    );
    render(<MyTokens />);
    expect(await screen.findByTestId("get-my-token")).toBeDisabled();
    expect(
      screen.getByText("An admin hasn't finished setting up the gateway's keys yet."),
    ).toBeInTheDocument();
  });

  it("rotates and gives up the key Optio made, each after a confirmation", async () => {
    getMyGateway.mockResolvedValue({ ...status, hasToken: true });
    getMyKey.mockResolvedValue(
      keyStatus({ modes: { personalPasted: true, optioIssued: true }, canIssue: true, issued }),
    );
    rotateMyKey.mockResolvedValue({
      action: "rotate",
      key: { ...issued, id: "k2", keyHint: "c3d4" },
      secretName: "ANTHROPIC_AUTH_TOKEN",
      test: { ok: true, modelCount: 2 },
    });
    revokeMyKey.mockResolvedValue({ revoked: 1 });
    render(<MyTokens />);
    await screen.findByTestId("my-issued-key");
    expect(screen.queryByTestId("get-my-token")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /rotate/i }));
    expect(screen.getByText("Rotate your key?")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Rotate" }).at(-1)!);
    await waitFor(() => expect(rotateMyKey).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /give up/i }));
    fireEvent.click(screen.getByRole("button", { name: "Give it up" }));
    await waitFor(() => expect(revokeMyKey).toHaveBeenCalledTimes(1));
  });

  it("keeps pasting when the key status can't be read", async () => {
    getMyKey.mockRejectedValue(new Error("boom"));
    render(<MyTokens />);
    expect(await screen.findByPlaceholderText("Paste your token")).toBeInTheDocument();
    expect(screen.queryByTestId("get-my-token")).toBeNull();
  });
});

describe("keyTermsLine", () => {
  it("says the budget and the key's life", () => {
    expect(keyTermsLine(defaults)).toBe("a budget of $25.00 per 30d, valid for 90d");
    expect(keyTermsLine({ maxBudget: null, budgetDuration: null, keyDuration: null })).toBe(
      "no budget cap, no expiry",
    );
  });
});
