import { describe, expect, it } from "vitest";
import { OPENCODE_GLOBAL_AGENTS_MD, OPENCODE_GLOBAL_AGENTS_MD_PATH } from "@optio/agent-adapters";
import {
  opencodeRulesPath,
  withOpencodeRules,
  writesOpencodeRunConfig,
} from "./opencode-run-setup.js";

describe("writesOpencodeRunConfig", () => {
  it("is every OpenCode run's, and no other runtime's", () => {
    expect(writesOpencodeRunConfig("opencode")).toBe(true);
    for (const other of ["claude-code", "codex", "gemini", "copilot", "cursor", null, undefined])
      expect(writesOpencodeRunConfig(other)).toBe(false);
  });
});

describe("withOpencodeRules", () => {
  it("adds the headless rules under the agent's home for an OpenCode run", () => {
    const files: { path: string; content: string }[] = [{ path: "TASK.md", content: "do it" }];
    withOpencodeRules("opencode", files);
    expect(opencodeRulesPath()).toBe("/home/agent/.config/opencode/AGENTS.md");
    expect(files).toEqual([
      { path: "TASK.md", content: "do it" },
      { path: opencodeRulesPath(), content: OPENCODE_GLOBAL_AGENTS_MD },
    ]);
  });

  it("adds them once, and not over the adapter's own copy", () => {
    const files = [{ path: OPENCODE_GLOBAL_AGENTS_MD_PATH, content: "the adapter's" }];
    withOpencodeRules("opencode", files);
    withOpencodeRules("opencode", files);
    expect(files).toEqual([{ path: OPENCODE_GLOBAL_AGENTS_MD_PATH, content: "the adapter's" }]);

    const pooled: { path: string; content: string }[] = [];
    withOpencodeRules("opencode", pooled);
    withOpencodeRules("opencode", pooled);
    expect(pooled).toHaveLength(1);
  });

  it("leaves every other runtime's files alone", () => {
    const files: { path: string; content: string }[] = [];
    for (const other of ["claude-code", "codex", null]) withOpencodeRules(other, files);
    expect(files).toEqual([]);
  });
});
