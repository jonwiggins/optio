import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("@/lib/gateway-keys-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/gateway-keys-api")>()),
  gatewayKeysApi: {
    getKeyIssuing: (...a: unknown[]) => getKeyIssuing(...a),
    saveKeyIssuing: (...a: unknown[]) => saveKeyIssuing(...a),
  },
}));

import { GatewayKeyIssuing, bodyOf, draftOf } from "./gateway-key-issuing";

const settings: KeyIssuingSettings = {
  providerId: "g1",
  modes: { personalPasted: true, optioIssued: false },
  defaults: {
    maxBudget: null,
    budgetDuration: "30d",
    models: [],
    keyDuration: null,
    teamMaxBudget: null,
    teamBudgetDuration: "30d",
  },
  hasAdminKey: false,
  catalogModels: ["qwen-internal", "claude-sonnet-internal"],
  staleModels: [],
};

beforeEach(() => {
  getKeyIssuing.mockReset().mockResolvedValue(settings);
  saveKeyIssuing.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});

afterEach(() => cleanup());

describe("the draft", () => {
  it("never leaves both ways off, and refuses an amount that isn't one", () => {
    const d = draftOf(settings);
    expect(bodyOf({ ...d, modes: { personalPasted: false, optioIssued: false } })).toBe(
      "Leave people at least one way to get a token",
    );
    expect(bodyOf({ ...d, maxBudget: "ten" })).toBe("A budget is an amount in USD, like 25");
  });

  it("sends the admin key only when typed, null when cleared, and no period without a budget", () => {
    const d = draftOf(settings);
    const plain = bodyOf(d);
    expect(plain).not.toHaveProperty("adminKey");
    expect(plain).toMatchObject({ defaults: { maxBudget: null, budgetDuration: null } });
    expect(bodyOf({ ...d, adminKey: " sk-master " })).toMatchObject({ adminKey: "sk-master" });
    expect(bodyOf({ ...d, clearAdminKey: true, adminKey: "x" })).toMatchObject({ adminKey: null });
    expect(bodyOf({ ...d, maxBudget: "5", budgetDuration: "7d" })).toMatchObject({
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
          teamMaxBudget: null,
          teamBudgetDuration: null,
        },
      }),
    );
    expect(await screen.findByText("The gateway takes it.")).toBeInTheDocument();
    expect(screen.getByText("Stored")).toBeInTheDocument();
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
