import { describe, it, expect } from "vitest";
import { mergeWorkDefaults } from "./work-defaults.js";

describe("mergeWorkDefaults", () => {
  const current = {
    runtime: "codex",
    agentOptions: { codex: { copilotModel: "gpt-5.5" }, "claude-code": { claudeModel: "opus" } },
    location: { runTarget: "local" as const, localHostId: "h1", localDir: "/Users/dev/app" },
  };

  it("replaces Where and the runtime, and only the given runtime's options", () => {
    expect(
      mergeWorkDefaults(current, {
        runtime: "claude-code",
        agentOptions: { "claude-code": { claudeModel: "sonnet", claudeEffort: "high" } },
        location: { runTarget: "cluster" },
      }),
    ).toEqual({
      runtime: "claude-code",
      agentOptions: {
        codex: { copilotModel: "gpt-5.5" },
        "claude-code": { claudeModel: "sonnet", claudeEffort: "high" },
      },
      location: { runTarget: "cluster" },
    });
  });

  it("keeps what the body leaves out", () => {
    expect(mergeWorkDefaults(current, { location: { runTarget: "cluster" } })).toEqual({
      ...current,
      location: { runTarget: "cluster" },
    });
    expect(mergeWorkDefaults(current, { runtime: "gemini" })).toEqual({
      ...current,
      runtime: "gemini",
    });
  });

  it("starts from nothing", () => {
    expect(
      mergeWorkDefaults(null, { location: { runTarget: "local", localHostId: "h2" } }),
    ).toEqual({ agentOptions: {}, location: { runTarget: "local", localHostId: "h2" } });
  });
});
