import { featuresFromEnv } from "@optio/shared/features";
import { describe, expect, it } from "vitest";
import { agentWritesChat, canShowChat } from "./session-view";

describe("Codex session views by features", () => {
  const codexLive = { state: "running", spec: { kind: "agent", agent: "codex" } };

  it("offers Codex's chat by default (no features, or the full one)", () => {
    expect(canShowChat(codexLive, false)).toBe(true);
    expect(canShowChat(codexLive, false, featuresFromEnv({}))).toBe(true);
    expect(agentWritesChat("codex", featuresFromEnv({}))).toBe(true);
  });

  it("renders no Codex session view under the restricted deployment", () => {
    expect(
      canShowChat(
        codexLive,
        false,
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe(false);
    expect(
      agentWritesChat(
        "codex",
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe(false);
    expect(
      agentWritesChat(
        "claude-code",
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toBe(true);
  });
});
