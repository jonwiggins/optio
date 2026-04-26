import { describe, it, expect } from "vitest";
import { resolveReviewConfig } from "./review-config.js";

describe("resolveReviewConfig", () => {
  describe("agent type resolution", () => {
    it("uses repoReviewAgentType when set (highest priority)", () => {
      const result = resolveReviewConfig({
        repoReviewAgentType: "gemini",
        repoDefaultAgentType: "claude-code",
        globalDefaultReviewAgentType: "codex",
      });
      expect(result.agentType).toBe("gemini");
    });

    it("falls back to repoDefaultAgentType when reviewAgentType is null", () => {
      const result = resolveReviewConfig({
        repoReviewAgentType: null,
        repoDefaultAgentType: "gemini",
        globalDefaultReviewAgentType: "codex",
      });
      expect(result.agentType).toBe("gemini");
    });

    it("falls back to globalDefaultReviewAgentType when both repo fields are null", () => {
      const result = resolveReviewConfig({
        repoReviewAgentType: null,
        repoDefaultAgentType: null,
        globalDefaultReviewAgentType: "gemini",
      });
      expect(result.agentType).toBe("gemini");
    });

    it("falls back to claude-code when nothing is set", () => {
      const result = resolveReviewConfig({});
      expect(result.agentType).toBe("claude-code");
    });
  });

  describe("model resolution", () => {
    it("uses repoReviewModel when it belongs to the resolved agent's catalog", () => {
      const result = resolveReviewConfig({
        repoReviewAgentType: "gemini",
        repoReviewModel: "gemini-2.5-pro",
      });
      expect(result.model).toBe("gemini-2.5-pro");
    });

    it("accepts a model alias as the per-repo model", () => {
      const result = resolveReviewConfig({
        repoDefaultAgentType: "claude-code",
        repoReviewModel: "sonnet",
      });
      expect(result.model).toBe("sonnet");
    });

    it("ignores a stored model that doesn't belong to the resolved agent's catalog", () => {
      const result = resolveReviewConfig({
        repoReviewAgentType: "gemini",
        // Legacy "sonnet" carried over from a Claude config — should be dropped.
        repoReviewModel: "sonnet",
      });
      expect(result.agentType).toBe("gemini");
      // Falls back to the gemini catalog default rather than erroring.
      expect(result.model).not.toBe("sonnet");
      expect(result.model).toMatch(/gemini-/);
    });

    it("falls back to globalDefaultReviewModel when the per-repo model is null", () => {
      const result = resolveReviewConfig({
        repoReviewAgentType: "claude-code",
        repoReviewModel: null,
        globalDefaultReviewModel: "claude-opus-4-7",
      });
      expect(result.model).toBe("claude-opus-4-7");
    });

    it("falls back to the catalog default when no model is set", () => {
      const result = resolveReviewConfig({
        repoDefaultAgentType: "gemini",
      });
      expect(result.agentType).toBe("gemini");
      // The Gemini catalog has a `latest` model; resolveModelId picks it.
      expect(result.model).toMatch(/gemini-/);
      expect(result.model.length).toBeGreaterThan(0);
    });
  });

  describe("design doc scenarios", () => {
    it("Gemini-only user: defaultAgentType=gemini routes reviews to Gemini", () => {
      // The user sets repoDefaultAgentType=gemini once and reviews follow,
      // even when reviewAgentType and reviewModel are unset.
      const result = resolveReviewConfig({
        repoReviewAgentType: null,
        repoDefaultAgentType: "gemini",
        repoReviewModel: null,
      });
      expect(result.agentType).toBe("gemini");
      expect(result.model).toMatch(/gemini-/);
    });

    it("Existing Claude user: no change in behavior", () => {
      // A repo created before this change has defaultAgentType=claude-code
      // and reviewModel=sonnet but no reviewAgentType.
      const result = resolveReviewConfig({
        repoReviewAgentType: null,
        repoDefaultAgentType: "claude-code",
        repoReviewModel: "sonnet",
      });
      expect(result.agentType).toBe("claude-code");
      expect(result.model).toBe("sonnet");
    });

    it("Per-repo override beats workspace default", () => {
      const result = resolveReviewConfig({
        repoReviewAgentType: "claude-code",
        repoDefaultAgentType: "gemini",
        globalDefaultReviewAgentType: "codex",
      });
      expect(result.agentType).toBe("claude-code");
    });
  });
});
