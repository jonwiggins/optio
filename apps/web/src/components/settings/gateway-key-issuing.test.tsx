import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { modelGatewayCapabilities } from "@optio/shared";
import type { KeyIssuingSettings } from "@/lib/gateway-keys-api";

// Settings → Model gateway → How people get tokens (workspace admins).

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

const getKeyIssuing = vi.fn();
const saveKeyIssuing = vi.fn();
const listKeys = vi.fn();
const revokeKey = vi.fn();
vi.mock("@/lib/gateway-keys-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/gateway-keys-api")>()),
  gatewayKeysApi: {
    getKeyIssuing: (...a: unknown[]) => getKeyIssuing(...a),
    saveKeyIssuing: (...a: unknown[]) => saveKeyIssuing(...a),
    listKeys: (...a: unknown[]) => listKeys(...a),
    revokeKey: (...a: unknown[]) => revokeKey(...a),
  },
}));

import { GatewayKeyIssuing, bodyOf, draftOf } from "./gateway-key-issuing";

const settings: KeyIssuingSettings = {
  providerId: "g1",
  gatewayType: "litellm",
  capabilities: modelGatewayCapabilities("litellm"),
  modes: { personalPasted: true, optioIssued: false },
  defaults: {
    maxBudget: null,
    budgetDuration: "30d",
    models: [],
    keyDuration: null,
  },
  hasAdminKey: false,
  catalogModels: ["qwen-internal", "claude-sonnet-internal"],
  staleModels: [],
};

beforeEach(() => {
  getKeyIssuing.mockReset().mockResolvedValue(settings);
  saveKeyIssuing.mockReset();
  listKeys.mockReset().mockResolvedValue({ keys: [] });
  revokeKey.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});

afterEach(() => cleanup());

describe("the draft", () => {
  it("never leaves both ways off, and refuses an amount that isn't one", () => {
    const d = draftOf(settings);
    expect(bodyOf({ ...d, modes: { personalPasted: false, optioIssued: false } }, "litellm")).toBe(
      "Leave people at least one way to get a token",
    );
    expect(bodyOf({ ...d, maxBudget: "ten" }, "litellm")).toBe(
      "A budget is an amount in USD, like 25",
    );
  });

  it("sends the admin key only when typed, null when cleared, and no period without a budget", () => {
    const d = draftOf(settings);
    const plain = bodyOf(d, "litellm");
    expect(plain).not.toHaveProperty("adminKey");
    expect(plain).toMatchObject({ defaults: { maxBudget: null, budgetDuration: null } });
    expect(bodyOf({ ...d, adminKey: " sk-master " }, "litellm")).toMatchObject({
      adminKey: "sk-master",
    });
    expect(bodyOf({ ...d, clearAdminKey: true, adminKey: "x" }, "litellm")).toMatchObject({
      adminKey: null,
    });
    expect(bodyOf({ ...d, maxBudget: "5", budgetDuration: "7d" }, "litellm")).toMatchObject({
      defaults: { maxBudget: 5, budgetDuration: "7d" },
    });
  });
});

describe("GatewayKeyIssuing", () => {
  it("turns Optio-made keys on with the admin key, a budget and the models ticked", async () => {
    saveKeyIssuing.mockResolvedValue({
      settings: {
        ...settings,
        modes: { personalPasted: true, optioIssued: true },
        hasAdminKey: true,
      },
      adminKeyTest: { ok: true },
      changed: ["optioIssued", "adminKey", "maxBudget"],
    });
    render(<GatewayKeyIssuing providerId="g1" sharedToken={false} />);
    await screen.findByTestId("gateway-key-issuing");
    expect(getKeyIssuing).toHaveBeenCalledWith("g1");
    expect(screen.getByText("Not stored")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("mode-optio-issued"));
    fireEvent.change(screen.getByPlaceholderText("sk-…"), { target: { value: "sk-master" } });
    fireEvent.change(screen.getByLabelText("A person's budget in USD"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByLabelText("qwen-internal"));
    fireEvent.click(screen.getByTestId("save-key-issuing"));

    await waitFor(() =>
      expect(saveKeyIssuing).toHaveBeenCalledWith("g1", {
        modes: { personalPasted: true, optioIssued: true },
        adminKey: "sk-master",
        defaults: {
          maxBudget: 5,
          budgetDuration: "30d",
          models: ["qwen-internal"],
          keyDuration: null,
        },
      }),
    );
    expect(await screen.findByText("The gateway takes it.")).toBeInTheDocument();
    expect(screen.getByText("Stored")).toBeInTheDocument();
    // With the admin key stored, the keys Optio made are listed.
    await waitFor(() => expect(listKeys).toHaveBeenCalledWith("g1"));
  });

  it("offers OpenRouter no per-key models and sends none", async () => {
    const or: KeyIssuingSettings = {
      ...settings,
      gatewayType: "openrouter",
      capabilities: modelGatewayCapabilities("openrouter"),
    };
    getKeyIssuing.mockResolvedValue(or);
    render(<GatewayKeyIssuing providerId="g1" sharedToken={false} />);
    await screen.findByTestId("gateway-key-issuing");
    expect(screen.getByText(/OpenRouter management key/)).toBeInTheDocument();
    expect(screen.queryByText("Models a key may call")).not.toBeInTheDocument();
    expect(bodyOf({ ...draftOf(or), models: ["x"] }, "openrouter")).toMatchObject({
      defaults: expect.not.objectContaining({ models: expect.anything() }),
    });
  });

  it("a generic or Portkey gateway takes pasted tokens only, and says so", async () => {
    for (const type of ["generic", "portkey"] as const) {
      getKeyIssuing.mockResolvedValue({
        ...settings,
        gatewayType: type,
        capabilities: modelGatewayCapabilities(type),
      });
      render(<GatewayKeyIssuing providerId="g1" sharedToken={false} />);
      expect(
        await screen.findByText(/paste the keys they got from the gateway/),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("mode-optio-issued")).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("lists the keys Optio made, never a value, and revokes one", async () => {
    getKeyIssuing.mockResolvedValue({ ...settings, hasAdminKey: true });
    listKeys.mockResolvedValue({
      keys: [
        {
          id: "k1",
          keyAlias: "optio-alice",
          keyHint: "wxyz",
          models: [],
          maxBudget: 10,
          budgetDuration: "30d",
          expiresAt: null,
          createdAt: "2026-10-30T00:00:00Z",
          spendUsd: 4,
          budgetResetAt: null,
          checkedAt: null,
          user: { id: "u2", name: "Alice", email: "alice@example.com" },
        },
      ],
    });
    revokeKey.mockResolvedValue({ revoked: 1 });
    vi.stubGlobal("confirm", () => true);
    render(<GatewayKeyIssuing providerId="g1" sharedToken={false} />);
    const list = await screen.findByTestId("issued-key-list");
    expect(list.textContent).toContain("Alice");
    expect(list.textContent).toContain("…wxyz");
    expect(list.textContent).toContain("$4.00 of $10.00 per 30d spent");
    fireEvent.click(screen.getByText("Revoke"));
    await waitFor(() => expect(revokeKey).toHaveBeenCalledWith("g1", "k1"));
    vi.unstubAllGlobals();
  });

  it("says when the gateway refused the admin key it kept", async () => {
    saveKeyIssuing.mockResolvedValue({
      settings: { ...settings, hasAdminKey: true },
      adminKeyTest: { ok: false, error: "401: not an admin" },
      changed: ["adminKey"],
    });
    render(<GatewayKeyIssuing providerId="g1" sharedToken={false} />);
    fireEvent.change(await screen.findByPlaceholderText("sk-…"), { target: { value: "sk-user" } });
    fireEvent.click(screen.getByTestId("save-key-issuing"));
    expect(
      await screen.findByText("The gateway refused it: 401: not an admin"),
    ).toBeInTheDocument();
    expect(toast.warning).toHaveBeenCalled();
  });

  it("refuses to turn both ways off without asking the API", async () => {
    render(<GatewayKeyIssuing providerId="g1" sharedToken={false} />);
    fireEvent.click(await screen.findByLabelText(/People paste their own keys/));
    fireEvent.click(screen.getByTestId("save-key-issuing"));
    expect(toast.error).toHaveBeenCalledWith("Leave people at least one way to get a token");
    expect(saveKeyIssuing).not.toHaveBeenCalled();
  });

  it("shows a picked model the catalog stopped serving, flagged, so it can be unticked", async () => {
    getKeyIssuing.mockResolvedValue({
      ...settings,
      defaults: { ...settings.defaults, models: ["qwen-internal", "old-model"] },
      staleModels: ["old-model"],
    });
    saveKeyIssuing.mockResolvedValue({
      settings: { ...settings, defaults: { ...settings.defaults, models: ["qwen-internal"] } },
      adminKeyTest: null,
      changed: ["models"],
    });
    render(<GatewayKeyIssuing providerId="g1" sharedToken={false} />);
    const old = await screen.findByLabelText(/old-model/);
    expect(old).toBeChecked();
    expect(screen.getByText("no longer served")).toBeInTheDocument();
    expect(screen.getByText(/is left out of new keys/)).toBeInTheDocument();
    fireEvent.click(old);
    fireEvent.click(screen.getByTestId("save-key-issuing"));
    await waitFor(() =>
      expect(saveKeyIssuing).toHaveBeenCalledWith(
        "g1",
        expect.objectContaining({
          defaults: expect.objectContaining({ models: ["qwen-internal"] }),
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("no longer served")).not.toBeInTheDocument());
  });

  it("can't turn Optio-made keys on for a gateway with one shared token", async () => {
    render(<GatewayKeyIssuing providerId="g1" sharedToken />);
    expect(await screen.findByTestId("mode-optio-issued")).toBeDisabled();
    expect(
      screen.getByText(/Only for a gateway where each run uses its owner's token/),
    ).toBeInTheDocument();
  });
});
