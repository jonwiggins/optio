import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MyGatewayKey } from "@/lib/gateway-keys-api";

// Settings → My tokens: the viewer's own gateway token, pasted or made by Optio.

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

const setMyGatewayToken = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { setMyGatewayToken: (...a: unknown[]) => setMyGatewayToken(...a) },
}));

const issueMyKey = vi.fn();
const rotateMyKey = vi.fn();
const revokeMyKey = vi.fn();
vi.mock("@/lib/gateway-keys-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/gateway-keys-api")>()),
  gatewayKeysApi: {
    issueMyKey: (...a: unknown[]) => issueMyKey(...a),
    rotateMyKey: (...a: unknown[]) => rotateMyKey(...a),
    revokeMyKey: (...a: unknown[]) => revokeMyKey(...a),
  },
}));

import { PersonalGatewayToken, keyTermsLine } from "./my-gateway-key";

const issued = {
  id: "k1",
  keyAlias: "optio-bob",
  keyHint: "abcd",
  models: [],
  maxBudget: 10,
  budgetDuration: "30d",
  expiresAt: null,
  createdAt: "2026-10-30T00:00:00Z",
  spendUsd: 2.5,
  budgetResetAt: null,
  checkedAt: null,
};

const status = (patch: Partial<MyGatewayKey> = {}): MyGatewayKey => ({
  gateway: { id: "g1", name: "LiteLLM", type: "litellm" },
  modes: { personalPasted: true, optioIssued: true },
  canIssue: true,
  issued: null,
  defaults: { maxBudget: 10, budgetDuration: "30d", keyDuration: "90d" },
  ...patch,
});

const onChanged = vi.fn();

beforeEach(() => {
  [setMyGatewayToken, issueMyKey, rotateMyKey, revokeMyKey, onChanged].forEach((f) =>
    f.mockReset(),
  );
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(() => cleanup());

describe("PersonalGatewayToken", () => {
  it("says what a key gets, and Get my token makes one for this gateway", async () => {
    expect(keyTermsLine(status().defaults)).toBe("a budget of $10.00 per 30d, valid for 90d");
    issueMyKey.mockResolvedValue({
      action: "issue",
      key: issued,
      test: { ok: true, modelCount: 2 },
    });
    render(
      <PersonalGatewayToken
        providerId="g1"
        keyStatus={status()}
        hasToken={false}
        usageLine={null}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByTestId("get-my-token"));
    await waitFor(() => expect(issueMyKey).toHaveBeenCalledWith("g1"));
    expect(onChanged).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Your token is ready", {
      description: "optio-bob …abcd",
    });
  });

  it("hides the paste field when only Optio-made keys are taken", () => {
    render(
      <PersonalGatewayToken
        providerId="g1"
        keyStatus={status({ modes: { personalPasted: false, optioIssued: true } })}
        hasToken={false}
        usageLine={null}
        onChanged={onChanged}
      />,
    );
    expect(screen.queryByTestId("my-token")).not.toBeInTheDocument();
    expect(screen.getByTestId("get-my-token")).toBeEnabled();
  });

  it("shows the key Optio made, its spend, and rotates or gives it up", async () => {
    rotateMyKey.mockResolvedValue({
      action: "rotate",
      key: issued,
      test: { ok: true, modelCount: 2 },
    });
    revokeMyKey.mockResolvedValue({ revoked: 1 });
    render(
      <PersonalGatewayToken
        providerId="g1"
        keyStatus={status({ issued })}
        hasToken
        usageLine={null}
        onChanged={onChanged}
      />,
    );
    const key = screen.getByTestId("my-issued-key");
    expect(key.textContent).toContain("optio-bob");
    expect(key.textContent).toContain("$2.50 of $10.00 per 30d spent");
    fireEvent.click(screen.getByRole("button", { name: /Rotate/ }));
    // The popover's own Rotate confirms.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Rotate/ })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: /Rotate/ })[1]);
    await waitFor(() => expect(rotateMyKey).toHaveBeenCalledWith("g1"));
    fireEvent.click(screen.getByRole("button", { name: /Give up/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Give it up" }));
    await waitFor(() => expect(revokeMyKey).toHaveBeenCalledWith("g1"));
  });

  it("keeps pasting when the key status couldn't be read", () => {
    render(
      <PersonalGatewayToken
        providerId="g1"
        keyStatus={null}
        hasToken={false}
        usageLine={null}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByTestId("my-token")).toBeInTheDocument();
    expect(screen.queryByTestId("get-my-token")).not.toBeInTheDocument();
  });
});
