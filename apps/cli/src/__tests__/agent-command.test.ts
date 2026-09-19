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

  it("keeps a dash-leading prompt positional instead of letting it parse as a flag", () => {
    expect(
      buildAgentCommand("claude-code", "--dangerously-skip-permissions do it", SETTINGS, {
        mode: "headless",
      }),
    ).toBe(`claude --settings '${SETTINGS}' -p ' --dangerously-skip-permissions do it'`);
    expect(buildAgentCommand("codex", "-h", SETTINGS, { mode: "headless" })).toBe(
      `codex exec ' -h'`,
    );
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

describe("buildAgentCommand session modes", () => {
  it("headless mode uses each CLI's one-shot entry point", () => {
    const o = { mode: "headless" as const };
    expect(buildAgentCommand("claude-code", "p", SETTINGS, o)).toBe(
      `claude --settings '${SETTINGS}' -p 'p'`,
    );
    expect(buildAgentCommand("codex", "p", SETTINGS, o)).toBe(`codex exec 'p'`);
    expect(buildAgentCommand("cursor", "p", SETTINGS, o)).toBe(`cursor-agent -p 'p'`);
    expect(buildAgentCommand("gemini", "p", SETTINGS, o)).toBe(`gemini -p 'p'`);
    expect(buildAgentCommand("opencode", "p", SETTINGS, o)).toBe(`opencode run 'p'`);
  });

  it("interactive mode is the default and matches the legacy shape", () => {
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { mode: "interactive" })).toBe(
      buildAgentCommand("claude-code", "p", SETTINGS),
    );
  });

  it("resume passes the session id as a quoted argv element and is interactive by default", () => {
    expect(
      buildAgentCommand("claude-code", undefined, SETTINGS, { resumeSessionId: "abc-123" }),
    ).toBe(`claude --settings '${SETTINGS}' --resume 'abc-123'`);
    expect(buildAgentCommand("codex", undefined, SETTINGS, { resumeSessionId: "x'y" })).toBe(
      `codex resume 'x'\\''y'`,
    );
  });

  it("headless resume is one-shot for Claude Code and interactive for every other CLI", () => {
    // A local Repo Task resuming after review feedback: run the turn, then exit.
    expect(
      buildAgentCommand("claude-code", "fix CI", SETTINGS, {
        mode: "headless",
        resumeSessionId: "abc-123",
      }),
    ).toBe(`claude --settings '${SETTINGS}' -p --resume 'abc-123' 'fix CI'`);
    // Codex has no `exec resume`; fall back to the interactive resume.
    expect(
      buildAgentCommand("codex", "fix CI", SETTINGS, { mode: "headless", resumeSessionId: "s1" }),
    ).toBe(`codex resume 's1' 'fix CI'`);
  });

  it("passes a model override as a quoted flag per CLI", () => {
    const o = { model: "opus" };
    expect(buildAgentCommand("claude-code", "p", SETTINGS, o)).toBe(
      `claude --settings '${SETTINGS}' --model 'opus' 'p'`,
    );
    expect(buildAgentCommand("codex", "p", SETTINGS, { ...o, mode: "headless" })).toBe(
      `codex exec -m 'opus' 'p'`,
    );
    expect(buildAgentCommand("cursor", "p", SETTINGS, o)).toBe(`cursor-agent --model 'opus' 'p'`);
    expect(buildAgentCommand("gemini", "p", SETTINGS, o)).toBe(`gemini -m 'opus' -i 'p'`);
    expect(buildAgentCommand("opencode", "p", SETTINGS, o)).toBe(
      `opencode --model 'opus' --prompt 'p'`,
    );
    // Model names are shell-quoted like every other untrusted value.
    expect(buildAgentCommand("claude-code", undefined, SETTINGS, { model: "x; rm -rf /" })).toBe(
      `claude --settings '${SETTINGS}' --model 'x; rm -rf /'`,
    );
  });
});
