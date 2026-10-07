import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { ANTHROPIC_CATALOG, mergeLiveModels } from "@optio/shared";

const getAgentProviderOptions = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getAgentProviderOptions: (...args: unknown[]) => getAgentProviderOptions(...args) },
}));

import { ReviewAgentPicker } from "./review-agent-picker";

/** The live list a key that can see Opus 5.5 would get. */
const liveCatalog = mergeLiveModels(ANTHROPIC_CATALOG, [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
]);

function modelSelect(): HTMLSelectElement {
  // Agent first, model second.
  return screen.getAllByRole("combobox")[1] as HTMLSelectElement;
}

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

describe("ReviewAgentPicker (#644)", () => {
  it("lists the live models, not only the baseline catalog", async () => {
    render(
      <ReviewAgentPicker
        agentType="claude-code"
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
      />,
    );
    expect(ANTHROPIC_CATALOG.models.some((m) => m.id === "claude-opus-5-5")).toBe(false);
    await within(modelSelect()).findByRole("option", { name: /Opus 5\.5/ });
    expect(getAgentProviderOptions).toHaveBeenCalledWith("anthropic");
  });

  it("keeps the baseline list when the live fetch fails", async () => {
    getAgentProviderOptions.mockRejectedValue(new Error("offline"));
    render(
      <ReviewAgentPicker
        agentType="claude-code"
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
      />,
    );
    await vi.waitFor(() => expect(getAgentProviderOptions).toHaveBeenCalled());
    const options = within(modelSelect()).getAllByRole("option");
    expect(options.length).toBe(ANTHROPIC_CATALOG.models.length + 1); // + "Default"
    expect(options.some((o) => /Opus 5\.5/.test(o.textContent ?? ""))).toBe(false);
  });

  it("keeps a saved model the list does not offer selectable", async () => {
    render(
      <ReviewAgentPicker
        agentType="claude-code"
        onAgentTypeChange={() => {}}
        model="claude-opus-9-9"
        onModelChange={() => {}}
      />,
    );
    await within(modelSelect()).findByRole("option", { name: /Opus 5\.5/ });
    expect(modelSelect().value).toBe("claude-opus-9-9");
    expect(within(modelSelect()).getByRole("option", { name: "claude-opus-9-9" })).toBeTruthy();
  });

  it("fetches each agent's provider once, and nothing while inheriting", async () => {
    const { rerender } = render(
      <ReviewAgentPicker
        agentType={null}
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
        allowInherit
      />,
    );
    expect(getAgentProviderOptions).not.toHaveBeenCalled();
    rerender(
      <ReviewAgentPicker
        agentType="gemini"
        onAgentTypeChange={() => {}}
        model=""
        onModelChange={() => {}}
        allowInherit
      />,
    );
    await vi.waitFor(() => expect(getAgentProviderOptions).toHaveBeenCalledWith("gemini"));
    expect(getAgentProviderOptions).toHaveBeenCalledTimes(1);
  });
});
