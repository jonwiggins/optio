import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { ANTHROPIC_CATALOG, mergeLiveModels } from "@optio/shared";

const getAgentProviderOptions = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getAgentProviderOptions: (...args: unknown[]) => getAgentProviderOptions(...args) },
}));

import { AgentOptionsPicker } from "./agent-options-picker";

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

describe("AgentOptionsPicker latestAliases", () => {
  it("offers each family's alias as an always-latest choice, named by the live list", async () => {
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "opus" }}
        onChange={vi.fn()}
        modelOnly
        latestAliases
      />,
    );
    const select = screen.getByRole("combobox");
    // The stored alias stays the alias.
    expect(select).toHaveValue("opus");
    const group = await screen.findByRole("group", { name: "Always the latest" });
    expect(within(group).getByRole("option", { name: "Opus · now Opus 5.5" })).toHaveValue("opus");
    expect(within(group).getByRole("option", { name: /^Sonnet · now/ })).toHaveValue("sonnet");
    expect(screen.getByText(/moves to each new release on its own/)).toBeInTheDocument();
  });

  it("stores the alias or a pinned id as picked", async () => {
    const onChange = vi.fn();
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "opus" }}
        onChange={onChange}
        modelOnly
        latestAliases
      />,
    );
    await screen.findByRole("option", { name: "Opus · now Opus 5.5" });
    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "claude-opus-5-5" } });
    expect(onChange).toHaveBeenLastCalledWith({ claudeModel: "claude-opus-5-5" });
    fireEvent.change(select, { target: { value: "sonnet" } });
    expect(onChange).toHaveBeenLastCalledWith({ claudeModel: "sonnet" });
  });

  it("without it, a stored alias shows as the model it names", () => {
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "opus" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("combobox")[0]).toHaveValue("claude-opus-4-8");
    expect(screen.queryByRole("group", { name: "Always the latest" })).not.toBeInTheDocument();
  });

  it("keeps showing a saved model the list doesn't offer", () => {
    getAgentProviderOptions.mockReturnValue(new Promise(() => {})); // live list never arrives
    render(
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: "claude-opus-9" }}
        onChange={vi.fn()}
        modelOnly
        latestAliases
      />,
    );
    expect(screen.getByRole("combobox")).toHaveValue("claude-opus-9");
    expect(screen.getByRole("option", { name: "claude-opus-9" })).toBeInTheDocument();
  });
});
