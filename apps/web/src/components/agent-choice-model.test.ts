import { describe, it, expect } from "vitest";
import {
  REPO_FACTORY_OPTIONS,
  agentSummary,
  defaultModelFor,
  optionKeysFor,
  optionsFromRepo,
  repoAgentPatch,
  repoAgentValues,
  repoHasOwnOptions,
  repoOwnRuntime,
  reviewModelField,
} from "./agent-choice-model";

const repo = (over: Record<string, unknown> = {}) => ({
  defaultAgentType: "claude-code",
  ...REPO_FACTORY_OPTIONS,
  copilotModel: null,
  copilotEffort: null,
  opencodeBaseUrl: null,
  ...over,
});

describe("agent-choice-model — picker keys are repo columns", () => {
  it("lists the model field first, local-only fields only when asked", () => {
    expect(optionKeysFor("claude-code")[0]).toBe("claudeModel");
    expect(optionKeysFor("claude-code")).toContain("claudePermissionMode");
    expect(optionKeysFor("claude-code", true)).not.toContain("claudePermissionMode");
    expect(optionKeysFor("")).toEqual([]);
  });

  it("seeds a runtime's picker from the repo row, ignoring nulls and other agents", () => {
    const r = repo({ claudeModel: "sonnet", geminiModel: "gemini-2.5-flash" });
    expect(optionsFromRepo("claude-code", r)).toEqual({
      claudeModel: "sonnet",
      claudeContextWindow: "1m",
      claudeThinking: true,
      claudeEffort: "high",
    });
    expect(optionsFromRepo("copilot", r)).toEqual({});
    // Codex shares Copilot's columns, which hold Copilot's settings.
    expect(optionsFromRepo("codex", repo({ copilotModel: "gpt-5" }))).toEqual({});
    expect(optionsFromRepo("claude-code", null)).toEqual({});
  });

  it("reads every agent column into one map, null columns as the column default", () => {
    const v = repoAgentValues({ claudeModel: "sonnet", claudeEffort: null, cursorModel: "auto" });
    expect(v.claudeModel).toBe("sonnet");
    expect(v.claudeEffort).toBe("high");
    expect(v.cursorModel).toBe("auto");
    expect(v.geminiApprovalMode).toBe("yolo");
  });

  it("writes the PATCH body the settings page always sent", () => {
    const patch = repoAgentPatch("gemini", {
      ...REPO_FACTORY_OPTIONS,
      claudeEffort: "",
      copilotModel: "",
      opencodeBaseUrl: "",
      claudePermissionMode: "plan",
    });
    expect(patch.defaultAgentType).toBe("gemini");
    expect(patch.claudeModel).toBe("opus");
    // Claude's blank effort goes as-is (the model's own default) …
    expect(patch.claudeEffort).toBe("");
    expect(patch.claudeThinking).toBe(true);
    // … other blanks are left alone, the base URL blank clears it.
    expect(patch.copilotModel).toBeUndefined();
    expect(patch.opencodeBaseUrl).toBeNull();
    // A field only a run on your machine takes has no column.
    expect("claudePermissionMode" in patch).toBe(false);
  });

  it("tells a configured repo from one left at the column defaults", () => {
    expect(repoHasOwnOptions("claude-code", repo())).toBe(false);
    expect(repoHasOwnOptions("claude-code", repo({ claudeEffort: "max" }))).toBe(true);
    expect(repoOwnRuntime(repo())).toBeNull();
    expect(repoOwnRuntime(repo({ claudeModel: "sonnet" }))).toBe("claude-code");
    expect(repoOwnRuntime(repo({ defaultAgentType: "gemini" }))).toBe("gemini");
    expect(repoOwnRuntime(repo({ defaultAgentType: "nope" }))).toBeNull();
  });

  it("summarizes as runtime · model · effort", () => {
    expect(agentSummary("claude-code", { claudeModel: "opus", claudeEffort: "high" })).toBe(
      "Claude Code · opus · high",
    );
    expect(agentSummary("codex", { copilotModel: "gpt-5" })).toBe("OpenAI Codex");
    expect(agentSummary("", {})).toBe("");
  });

  it("maps a review agent's model to its catalog field and default", () => {
    expect(reviewModelField("claude-code")).toBe("claudeModel");
    expect(reviewModelField("")).toBeNull();
    expect(defaultModelFor("")).toBe("");
    expect(defaultModelFor("claude-code")).not.toBe("");
  });
});
