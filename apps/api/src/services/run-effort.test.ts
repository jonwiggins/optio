import { describe, expect, it, vi } from "vitest";

vi.mock("../db/client.js", () => ({ db: {} }));
const mockGetProviderOptions = vi.fn();
vi.mock("./agent-options-service.js", () => ({
  getProviderOptions: (...args: unknown[]) => mockGetProviderOptions(...args),
}));

import { OPENAI_CATALOG, getProviderCatalog } from "@optio/shared";
import type { ModelProviderRow } from "./model-provider-service.js";
import { gatewayEffort, runEffort, withModelEfforts } from "./run-effort.js";

mockGetProviderOptions.mockImplementation(async (provider: string) => ({
  catalog: getProviderCatalog(provider),
}));

describe("runEffort", () => {
  it("drops an effort the model takes none of, keeps one it lists", async () => {
    expect(await runEffort("claude-code", "haiku", "high", "ws-1")).toBeUndefined();
    expect(await runEffort("claude-code", "opus", "high", "ws-1")).toBe("high");
    expect(mockGetProviderOptions).toHaveBeenCalledWith("anthropic", { workspaceId: "ws-1" });
  });

  it("falls back to the baseline catalog when the probe fails", async () => {
    mockGetProviderOptions.mockRejectedValueOnce(new Error("no network"));
    expect(await runEffort("claude-code", "haiku", "high")).toBeUndefined();
  });

  it("no effort asked: no lookup", async () => {
    mockGetProviderOptions.mockClear();
    expect(await runEffort("claude-code", "opus", undefined)).toBeUndefined();
    expect(mockGetProviderOptions).not.toHaveBeenCalled();
  });
});

describe("withModelEfforts", () => {
  it("strips claudeEffort for a model that takes none, keeping the rest", async () => {
    expect(
      await withModelEfforts(
        "claude-code",
        { claudeModel: "haiku", claudeEffort: "high", claudeThinking: true },
        null,
      ),
    ).toEqual({ claudeModel: "haiku", claudeThinking: true });
  });

  it("reads the legacy model column when the options name none", async () => {
    expect(
      await withModelEfforts("claude-code", { claudeEffort: "high" }, "claude-haiku-4-5-20251001"),
    ).toEqual({});
  });

  it("Codex: an effort its model doesn't list goes", async () => {
    const model = OPENAI_CATALOG.models.find((m) => m.efforts?.length)!;
    const opts = { copilotModel: model.id, copilotEffort: "not-an-effort" };
    expect(await withModelEfforts("codex", opts, null)).toEqual({ copilotModel: model.id });
    const ok = { copilotModel: model.id, copilotEffort: model.efforts![0]! };
    expect(await withModelEfforts("codex", ok, null)).toBe(ok);
  });

  it("leaves other agents and option-less runs alone", async () => {
    expect(await withModelEfforts("gemini", { geminiModel: "x" }, null)).toEqual({
      geminiModel: "x",
    });
    expect(await withModelEfforts("claude-code", null, null)).toBeNull();
  });
});

describe("gatewayEffort", () => {
  const row = (models: unknown) =>
    ({ baseUrl: "https://gw", authHeader: "bearer", models }) as unknown as ModelProviderRow;

  it("a model with no efforts list takes none, even with a default", () => {
    expect(
      gatewayEffort({
        row: row({ "claude-code": [{ id: "m", defaultEffort: "high" }] }),
        agent: "claude-code",
        pick: { model: "m", effort: "high" },
      }),
    ).toBeUndefined();
  });

  it("keeps an effort the model lists", () => {
    expect(
      gatewayEffort({
        row: row({ "claude-code": [{ id: "m", efforts: ["low", "high"] }] }),
        agent: "claude-code",
        pick: { model: "m", effort: "high" },
      }),
    ).toBe("high");
  });
});
