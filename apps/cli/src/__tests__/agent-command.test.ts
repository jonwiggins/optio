import { describe, it, expect } from "vitest";
import { buildAgentCommand } from "../local/agent-command.js";

const SETTINGS = "/home/u/.config/optio/local/claude-hooks.json";

describe("buildAgentCommand", () => {
  it("claude-code includes --settings and the single-quoted prompt", () => {
    expect(buildAgentCommand("claude-code", "fix the login bug", SETTINGS)).toBe(
      `claude --settings '${SETTINGS}' 'fix the login bug'`,
    );
  });

  it("claude-code without a prompt still passes --settings", () => {
    expect(buildAgentCommand("claude-code", undefined, SETTINGS)).toBe(
      `claude --settings '${SETTINGS}'`,
    );
  });

  it("quotes prompts containing single quotes with the '\\'' escape", () => {
    expect(buildAgentCommand("codex", "don't break", SETTINGS)).toBe(`codex 'don'\\''t break'`);
  });

  it("neutralizes shell metacharacters in prompts", () => {
    expect(buildAgentCommand("codex", "$(rm -rf /); `id`", SETTINGS)).toBe(
      "codex '$(rm -rf /); `id`'",
    );
  });

  it("maps each agent to the right binary and prompt flag", () => {
    expect(buildAgentCommand("codex", "p", SETTINGS)).toBe(`codex 'p'`);
    expect(buildAgentCommand("cursor", "p", SETTINGS)).toBe(`cursor-agent 'p'`);
    expect(buildAgentCommand("gemini", "p", SETTINGS)).toBe(`gemini -i 'p'`);
    expect(buildAgentCommand("opencode", "p", SETTINGS)).toBe(`opencode --prompt 'p'`);
  });

  it("omits the prompt flag entirely when no prompt is given", () => {
    expect(buildAgentCommand("codex", undefined, SETTINGS)).toBe("codex");
    expect(buildAgentCommand("cursor", undefined, SETTINGS)).toBe("cursor-agent");
    expect(buildAgentCommand("gemini", undefined, SETTINGS)).toBe("gemini");
    expect(buildAgentCommand("opencode", undefined, SETTINGS)).toBe("opencode");
  });
});
