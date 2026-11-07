import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { ANTHROPIC_CATALOG, mergeLiveModels } from "@optio/shared";

const getAgentProviderOptions = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getAgentProviderOptions: (...args: unknown[]) => getAgentProviderOptions(...args) },
}));

import { AgentOptionsPicker } from "./agent-options-picker";
import { gatewayCatalogFor } from "./gateway-catalog";

/** The live list a key that can see Opus 5.5 would get. */
const liveCatalog = mergeLiveModels(ANTHROPIC_CATALOG, [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
]);

beforeEach(() => {
  getAgentProviderOptions.mockReset();
  getAgentProviderOptions.mockResolvedValue({
    catalog: liveCatalog,
    source: "live",
    cached: true,
    refreshedAt: 1,
  });
});

afterEach(() => cleanup());

/** A model gateway's catalog rows (Settings → Model gateway; docs/model-gateway.md). */
const gatewayModels = [
  {
    id: "claude-sonnet-internal",
    label: "Sonnet (internal)",
    contextWindow: 200000,
    maxOutputTokens: 32000,
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    role: "sonnet" as const,
  },
  { id: "claude-haiku-internal", label: "Haiku (internal)", efforts: [] },
  { id: "claude-old", missing: true },
];

describe("AgentOptionsPicker through a model gateway", () => {
  it("offers the gateway's catalog, narrows efforts to the model's, hides the context window", async () => {
    getAgentProviderOptions.mockResolvedValue({
      catalog: gatewayCatalogFor(ANTHROPIC_CATALOG, "LiteLLM", gatewayModels),
      source: "live",
      cached: false,
      refreshedAt: 1,
      gateway: { id: "g1", name: "LiteLLM", lastSyncedAt: null },
    });
    const onChange = vi.fn();
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "claude-sonnet-internal" }}
        onChange={onChange}
        providerModels={gatewayModels}
        gateway={{ id: "g1", name: "LiteLLM" }}
      />,
    );
    expect(getAgentProviderOptions).toHaveBeenCalledWith("anthropic", {
      refresh: false,
      hostId: undefined,
      gateway: "g1",
    });
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(model).toHaveValue("claude-sonnet-internal");
    // The gateway's models, not the stock list; a missing one says so.
    expect(within(model).getByRole("option", { name: "Sonnet (internal)" })).toBeInTheDocument();
    expect(within(model).getByRole("option", { name: "claude-old (missing)" })).toBeInTheDocument();
    expect(within(model).queryByRole("option", { name: /Opus 4\.8/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("gateway-model-hint")).toHaveTextContent(
      "200K context · 32K max output · via LiteLLM",
    );
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Context Window" })).not.toBeInTheDocument();

    const effort = screen.getByRole("combobox", { name: "Effort Level" });
    const choices = within(effort)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(choices).toEqual(["Low", "Medium", "High"]);
    // The pod default ("high") still applies as the value the run gets.
    expect(effort).toHaveValue("high");

    // A model that takes no effort hides the field; its hint shows no limits.
    fireEvent.change(model, { target: { value: "claude-haiku-internal" } });
    expect(onChange).toHaveBeenLastCalledWith({ claudeModel: "claude-haiku-internal" });
  });

  it("starts from the catalog Settings holds while the API's answer is on the way", () => {
    getAgentProviderOptions.mockReturnValue(new Promise(() => {}));
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "claude-haiku-internal", claudeEffort: "high" }}
        onChange={vi.fn()}
        providerModels={gatewayModels}
        gateway={{ id: "g1", name: "LiteLLM" }}
      />,
    );
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(within(model).getByRole("option", { name: "Haiku (internal)" })).toBeInTheDocument();
    expect(within(model).queryByRole("option", { name: /Opus/ })).not.toBeInTheDocument();
    // No efforts on this model: no effort field at all.
    expect(screen.queryByRole("combobox", { name: "Effort Level" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Context Window" })).not.toBeInTheDocument();
    expect(screen.getByTestId("gateway-model-hint")).toHaveTextContent("via LiteLLM");
  });

  it("a gateway model that lists no efforts at all takes none either", () => {
    getAgentProviderOptions.mockReturnValue(new Promise(() => {}));
    const onChange = vi.fn();
    const models = [...gatewayModels, { id: "plain-model", label: "Plain" }];
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "claude-sonnet-internal", claudeEffort: "high" }}
        onChange={onChange}
        providerModels={models}
        gateway={{ id: "g1", name: "LiteLLM" }}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Effort Level" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
      target: { value: "plain-model" },
    });
    // The saved effort goes with the switch.
    expect(onChange).toHaveBeenLastCalledWith({ claudeModel: "plain-model", claudeEffort: "" });
    cleanup();
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "plain-model" }}
        onChange={vi.fn()}
        providerModels={models}
        gateway={{ id: "g1", name: "LiteLLM" }}
      />,
    );
    expect(screen.queryByRole("combobox", { name: "Effort Level" })).not.toBeInTheDocument();
  });
});
