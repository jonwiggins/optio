import { describe, it, expect } from "vitest";
import {
  ALL_PROVIDER_IDS,
  ANTHROPIC_CATALOG,
  COPILOT_CATALOG,
  GEMINI_CATALOG,
  OPENAI_CATALOG,
  OPENCLAW_CATALOG,
  OPENCODE_CATALOG,
  PROVIDER_CATALOGS,
  getProviderCatalog,
  groupModelsByFamily,
  mergeLiveModels,
  resolveModelId,
} from "./index.js";

describe("PROVIDER_CATALOGS", () => {
  it("has a catalog for every provider id", () => {
    for (const id of ALL_PROVIDER_IDS) {
      expect(PROVIDER_CATALOGS[id]).toBeDefined();
      expect(PROVIDER_CATALOGS[id].provider).toBe(id);
    }
  });

  it("has exactly one `latest` model per family for auth-gated providers", () => {
    for (const catalog of [ANTHROPIC_CATALOG, GEMINI_CATALOG]) {
      const byFamily = new Map<string, number>();
      for (const model of catalog.models) {
        if (!model.latest) continue;
        const key = model.family ?? model.id;
        byFamily.set(key, (byFamily.get(key) ?? 0) + 1);
      }
      for (const count of byFamily.values()) {
        expect(count).toBe(1);
      }
    }
  });

  it("marks free-text providers with modelIsFreeText", () => {
    expect(OPENCODE_CATALOG.modelIsFreeText).toBe(true);
    expect(OPENCLAW_CATALOG.modelIsFreeText).toBe(true);
    expect(ANTHROPIC_CATALOG.modelIsFreeText).toBeFalsy();
  });

  it("flags which providers support live refresh", () => {
    expect(ANTHROPIC_CATALOG.liveRefreshSupported).toBe(true);
    expect(OPENAI_CATALOG.liveRefreshSupported).toBe(true);
    expect(GEMINI_CATALOG.liveRefreshSupported).toBe(true);
    expect(COPILOT_CATALOG.liveRefreshSupported).toBe(false);
    expect(OPENCODE_CATALOG.liveRefreshSupported).toBe(false);
    expect(OPENCLAW_CATALOG.liveRefreshSupported).toBe(false);
  });

  it("points each provider at a stable modelField", () => {
    expect(ANTHROPIC_CATALOG.modelField).toBe("claudeModel");
    expect(OPENAI_CATALOG.modelField).toBe("copilotModel");
    expect(COPILOT_CATALOG.modelField).toBe("copilotModel");
    expect(GEMINI_CATALOG.modelField).toBe("geminiModel");
    expect(OPENCODE_CATALOG.modelField).toBe("opencodeModel");
    expect(OPENCLAW_CATALOG.modelField).toBe("openclawModel");
  });
});

describe("resolveModelId", () => {
  it("resolves the opus alias to the latest dated id", () => {
    expect(resolveModelId("anthropic", "opus")).toBe("claude-opus-4-7");
  });

  it("resolves the sonnet alias", () => {
    expect(resolveModelId("anthropic", "sonnet")).toBe("claude-sonnet-4-6");
  });

  it("resolves the haiku alias", () => {
    expect(resolveModelId("anthropic", "haiku")).toBe("claude-haiku-4-5-20251001");
  });

  it("returns an exact-match dated id unchanged", () => {
    expect(resolveModelId("anthropic", "claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("passes through unknown strings (future dated ids, free text)", () => {
    // Simulates a dated id that shipped before we updated the baseline.
    expect(resolveModelId("anthropic", "claude-opus-4-9-20990101")).toBe(
      "claude-opus-4-9-20990101",
    );
  });

  it("returns the latest-marked model when no input is provided", () => {
    // Pick a provider with an explicit `latest` flag.
    expect(resolveModelId("anthropic", undefined)).toBe("claude-opus-4-7");
  });

  it("returns undefined for free-text providers with no baseline models", () => {
    expect(resolveModelId("opencode", undefined)).toBeUndefined();
    expect(resolveModelId("openclaw", undefined)).toBeUndefined();
  });

  it("returns the input unchanged for free-text providers", () => {
    expect(resolveModelId("opencode", "anthropic/claude-sonnet-4")).toBe(
      "anthropic/claude-sonnet-4",
    );
  });

  it("treats an empty string like undefined", () => {
    expect(resolveModelId("anthropic", "")).toBe("claude-opus-4-7");
  });

  it("resolves gemini-pro alias", () => {
    expect(resolveModelId("gemini", "gemini-pro")).toBe("gemini-3-pro");
  });
});

describe("mergeLiveModels", () => {
  it("appends new live model ids not in the baseline", () => {
    const merged = mergeLiveModels(ANTHROPIC_CATALOG, [
      "claude-opus-4-7",
      "claude-opus-4-8-future",
    ]);
    const ids = merged.models.map((m) => m.id);
    expect(ids).toContain("claude-opus-4-8-future");
    // Original id is not duplicated
    expect(ids.filter((id) => id === "claude-opus-4-7").length).toBe(1);
  });

  it("preserves baseline metadata when a live id matches", () => {
    const opus = ANTHROPIC_CATALOG.models.find((m) => m.id === "claude-opus-4-7")!;
    const merged = mergeLiveModels(ANTHROPIC_CATALOG, ["claude-opus-4-7"]);
    const mergedOpus = merged.models.find((m) => m.id === "claude-opus-4-7")!;
    expect(mergedOpus.label).toBe(opus.label);
    expect(mergedOpus.latest).toBe(true);
    expect(mergedOpus.source).toBe("baseline");
  });

  it("tags new live entries with source=live", () => {
    const merged = mergeLiveModels(ANTHROPIC_CATALOG, ["claude-brand-new-id"]);
    const added = merged.models.find((m) => m.id === "claude-brand-new-id");
    expect(added).toBeDefined();
    expect(added!.source).toBe("live");
  });

  it("returns the same reference when there are no additions", () => {
    const merged = mergeLiveModels(ANTHROPIC_CATALOG, ["claude-opus-4-7"]);
    expect(merged).toBe(ANTHROPIC_CATALOG);
  });

  it("dedupes within the live list", () => {
    const merged = mergeLiveModels(ANTHROPIC_CATALOG, ["new-a", "new-a", "new-b"]);
    const added = merged.models.filter((m) => m.source === "live");
    expect(added.map((m) => m.id).sort()).toEqual(["new-a", "new-b"]);
  });

  it("skips empty/null-ish live ids", () => {
    const merged = mergeLiveModels(ANTHROPIC_CATALOG, ["", "legit-id"]);
    expect(merged.models.find((m) => m.id === "")).toBeUndefined();
    expect(merged.models.find((m) => m.id === "legit-id")).toBeDefined();
  });
});

describe("groupModelsByFamily", () => {
  it("groups anthropic models by family", () => {
    const groups = groupModelsByFamily(ANTHROPIC_CATALOG);
    const families = groups.map((g) => g.family).sort();
    expect(families).toEqual(["haiku", "opus", "sonnet"]);
  });

  it("falls back to the model id when there is no family", () => {
    const groups = groupModelsByFamily({
      provider: "anthropic",
      label: "x",
      modelField: "claudeModel",
      models: [{ id: "solo", label: "Solo" }],
      aliases: {},
      options: [],
      liveRefreshSupported: false,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].family).toBe("solo");
  });
});

describe("getProviderCatalog", () => {
  it("returns the catalog for a known provider", () => {
    expect(getProviderCatalog("anthropic")).toBe(ANTHROPIC_CATALOG);
  });

  it("returns undefined for an unknown provider", () => {
    expect(getProviderCatalog("nonexistent")).toBeUndefined();
  });
});
