import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { modelGatewayCapabilities } from "@optio/shared";
import type { KeyIssuingSettings } from "@/lib/gateway-keys-api";

// Settings → Model gateway per gateway type (docs/model-gateway.md "Gateway
// types"): the type picker, and only what the type supports offered.

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
import { GatewayTypeField } from "./gateway-editor";
import { budgetPeriodsFor } from "./gateway-budget-inputs";
import {
  emptyProviderForm,
  formFromProvider,
  toCreateInput,
  toUpdateInput,
} from "./model-provider-form";
import { gatewaySummary } from "./gateway-form";

const base: KeyIssuingSettings = {
  providerId: "g1",
  modes: { personalPasted: true, optioIssued: false },
  defaults: {
    maxBudget: null,
    budgetDuration: "1mo",
    models: [],
    keyDuration: null,
    teamMaxBudget: null,
    teamBudgetDuration: "1mo",
  },
  hasAdminKey: false,
  catalogModels: ["@anthropic-prod/claude-sonnet-4-5"],
  staleModels: [],
};

const ofType = (gatewayType: "portkey" | "generic" | "openrouter"): KeyIssuingSettings => ({
  ...base,
  gatewayType,
  capabilities: modelGatewayCapabilities(gatewayType),
});

beforeEach(() => {
  getKeyIssuing.mockReset();
  saveKeyIssuing.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(() => cleanup());

describe("budget periods per type", () => {
  it("offers OpenRouter's resets, Portkey's weeks, months and days, and LiteLLM's durations", () => {
    expect(budgetPeriodsFor("openrouter").map((p) => p.value)).toEqual(["1d", "1w", "1mo", ""]);
    expect(budgetPeriodsFor("portkey").map((p) => p.value)).toEqual([
      "1d",
      "1w",
      "1mo",
      "7d",
      "30d",
      "",
    ]);
    expect(budgetPeriodsFor(undefined).map((p) => p.value)).toEqual(["1d", "7d", "30d", "1mo", ""]);
  });
});

describe("How people get tokens, per type", () => {
  it("a Portkey gateway: its admin key's name, a workspace, no per-key models", async () => {
    getKeyIssuing.mockResolvedValue(ofType("portkey"));
    render(<GatewayKeyIssuing providerId="g1" sharedToken={false} />);
    await screen.findByTestId("gateway-key-issuing");
    expect(screen.getByText(/Portkey admin API key/)).toBeInTheDocument();
    expect(screen.queryByText("Models a key may call")).not.toBeInTheDocument();
    expect(screen.getByText(/doesn't report a key's spend/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Workspace (optional)"), {
      target: { value: "ws-1" },
    });
    saveKeyIssuing.mockResolvedValue({
      settings: ofType("portkey"),
      adminKeyTest: null,
      changed: [],
    });
    fireEvent.click(screen.getByTestId("save-key-issuing"));
    await waitFor(() =>
      expect(saveKeyIssuing).toHaveBeenCalledWith(
        "g1",
        expect.objectContaining({ defaults: expect.objectContaining({ workspace: "ws-1" }) }),
      ),
    );
  });

  it("a generic gateway takes pasted tokens only, and says so", async () => {
    getKeyIssuing.mockResolvedValue(ofType("generic"));
    render(<GatewayKeyIssuing providerId="g1" sharedToken={false} />);
    expect(await screen.findByText(/paste the keys they got from the gateway/)).toBeInTheDocument();
    expect(screen.queryByTestId("mode-optio-issued")).not.toBeInTheDocument();
    expect(screen.queryByTestId("save-key-issuing")).not.toBeInTheDocument();
  });

  it("sends a workspace only for Portkey", () => {
    const d = { ...draftOf(ofType("portkey")), workspace: " ws-2 " };
    expect(bodyOf(d, "portkey")).toMatchObject({ defaults: { workspace: "ws-2" } });
    expect((bodyOf(d, "openrouter") as { defaults: object }).defaults).not.toHaveProperty(
      "workspace",
    );
  });
});

describe("the gateway type picker", () => {
  it("fills a hosted type's public URL into an empty field, and clears it going back", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <GatewayTypeField value={undefined} baseUrl="" onChange={onChange} />,
    );
    const select = screen.getByTestId("gateway-type") as HTMLSelectElement;
    expect(select.value).toBe("litellm");
    fireEvent.change(select, { target: { value: "openrouter" } });
    expect(onChange).toHaveBeenLastCalledWith({
      gatewayType: "openrouter",
      baseUrl: "https://openrouter.ai/api",
    });
    rerender(
      <GatewayTypeField
        value="openrouter"
        baseUrl="https://openrouter.ai/api"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId("gateway-type"), { target: { value: "generic" } });
    expect(onChange).toHaveBeenLastCalledWith({ gatewayType: "generic", baseUrl: "" });
    // A URL someone typed stays.
    rerender(
      <GatewayTypeField value="litellm" baseUrl="https://gw.example.com" onChange={onChange} />,
    );
    fireEvent.change(screen.getByTestId("gateway-type"), { target: { value: "portkey" } });
    expect(onChange).toHaveBeenLastCalledWith({ gatewayType: "portkey" });
  });

  it("round-trips the type through the form, and leaves it out when none was picked", () => {
    const f = { ...emptyProviderForm(true, "gateway"), baseUrl: "https://api.portkey.ai" };
    expect(toCreateInput(f)).not.toHaveProperty("gatewayType");
    expect(toCreateInput({ ...f, gatewayType: "portkey" })).toMatchObject({
      gatewayType: "portkey",
    });
    const saved = {
      id: "g1",
      workspaceId: "w1",
      ownerUserId: null,
      ownerName: null,
      kind: "gateway" as const,
      gatewayType: "openrouter" as const,
      name: "Router",
      agents: ["claude-code" as const],
      region: "",
      models: { "claude-code": [] },
      localAwsProfile: null,
      podCredential: "none" as const,
      hasPodCredentials: false,
      baseUrl: "https://openrouter.ai/api",
      authHeader: "bearer" as const,
      syncUrl: null,
      lastSyncedAt: null,
      tokenSource: "personal" as const,
      mine: false,
      canEdit: true,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    };
    const form = formFromProvider(saved);
    expect(form.gatewayType).toBe("openrouter");
    expect(toUpdateInput(form, saved)).toMatchObject({ gatewayType: "openrouter" });
    expect(gatewaySummary(saved, () => "now")).toMatch(/^OpenRouter · Personal tokens/);
  });
});
