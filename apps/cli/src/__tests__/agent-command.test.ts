import { describe, it, expect } from "vitest";
import { buildAgentCommand } from "../local/agent-command.js";

const SETTINGS = "/home/u/.config/optio/local/claude-hooks.json";
// Claude Code starts in auto mode unless the spawn says otherwise.
const CLAUDE = `claude --settings '${SETTINGS}' --permission-mode auto`;

describe("buildAgentCommand", () => {
  it("claude-code includes --settings, auto mode and the single-quoted prompt", () => {
    expect(buildAgentCommand("claude-code", "fix the login bug", SETTINGS)).toBe(
      `${CLAUDE} 'fix the login bug'`,
    );
  });

  it("claude-code without a prompt still passes --settings", () => {
    expect(buildAgentCommand("claude-code", undefined, SETTINGS)).toBe(`${CLAUDE}`);
  });

  it("quotes prompts containing single quotes with the '\\'' escape", () => {
    expect(buildAgentCommand("codex", "don't break", SETTINGS)).toBe(`codex 'don'\\''t break'`);
  });

  it("keeps a dash-leading prompt positional instead of letting it parse as a flag", () => {
    expect(
      buildAgentCommand("claude-code", "--dangerously-skip-permissions do it", SETTINGS, {
        mode: "headless",
      }),
    ).toBe(`${CLAUDE} -p ' --dangerously-skip-permissions do it'`);
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
    expect(buildAgentCommand("claude-code", "p", SETTINGS, o)).toBe(`${CLAUDE} -p 'p'`);
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
    ).toBe(`${CLAUDE} --resume 'abc-123'`);
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
    ).toBe(`${CLAUDE} -p --resume 'abc-123' 'fix CI'`);
    // Codex has no `exec resume`; fall back to the interactive resume.
    expect(
      buildAgentCommand("codex", "fix CI", SETTINGS, { mode: "headless", resumeSessionId: "s1" }),
    ).toBe(`codex resume 's1' 'fix CI'`);
  });

  it("passes a model override as a quoted flag per CLI", () => {
    const o = { model: "opus" };
    expect(buildAgentCommand("claude-code", "p", SETTINGS, o)).toBe(`${CLAUDE} --model 'opus' 'p'`);
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
      `${CLAUDE} --model 'x; rm -rf /'`,
    );
  });
});

describe("buildAgentCommand permissions and effort", () => {
  it("launches Claude Code in auto mode by default, headless too", () => {
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { mode: "headless" })).toBe(
      `${CLAUDE} -p 'p'`,
    );
  });

  it("skips every check with --dangerously-skip-permissions, or asks first", () => {
    expect(
      buildAgentCommand("claude-code", "p", SETTINGS, { permissionMode: "bypassPermissions" }),
    ).toBe(`claude --settings '${SETTINGS}' --dangerously-skip-permissions 'p'`);
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { permissionMode: "default" })).toBe(
      `claude --settings '${SETTINGS}' --permission-mode default 'p'`,
    );
  });

  it("treats an unknown permission mode as auto", () => {
    expect(
      buildAgentCommand("claude-code", "p", SETTINGS, { permissionMode: "yolo" as never }),
    ).toBe(`${CLAUDE} 'p'`);
  });

  it("leaves out a mode or --effort the machine's claude doesn't take", () => {
    const old = {
      permissionModes: ["acceptEdits", "bypassPermissions", "default", "plan"],
      effort: false,
    };
    // Auto mode isn't there: start in its own default rather than refuse to start.
    expect(
      buildAgentCommand("claude-code", "p", SETTINGS, { claudeCaps: old, effort: "high" }),
    ).toBe(`claude --settings '${SETTINGS}' 'p'`);
    // Skipping checks is the long-standing flag and always passes.
    expect(
      buildAgentCommand("claude-code", "p", SETTINGS, {
        claudeCaps: old,
        permissionMode: "bypassPermissions",
      }),
    ).toBe(`claude --settings '${SETTINGS}' --dangerously-skip-permissions 'p'`);
    // Help that lists no modes: pass the mode as asked.
    expect(
      buildAgentCommand("claude-code", "p", SETTINGS, {
        claudeCaps: { permissionModes: null, effort: true },
      }),
    ).toBe(`${CLAUDE} 'p'`);
  });

  it("passes the effort to Claude Code and Codex", () => {
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { effort: "high", model: "opus" })).toBe(
      `${CLAUDE} --model 'opus' --effort 'high' 'p'`,
    );
    expect(
      buildAgentCommand("codex", "p", SETTINGS, { effort: "xhigh", model: "gpt-5.6-sol" }),
    ).toBe(`codex -m 'gpt-5.6-sol' -c 'model_reasoning_effort="xhigh"' 'p'`);
    expect(buildAgentCommand("codex", "p", SETTINGS, { effort: "low", mode: "headless" })).toBe(
      `codex exec -c 'model_reasoning_effort="low"' 'p'`,
    );
    expect(
      buildAgentCommand("codex", undefined, SETTINGS, { effort: "max", resumeSessionId: "s" }),
    ).toBe(`codex resume -c 'model_reasoning_effort="max"' 's'`);
  });

  it("drops an effort that isn't a plain word", () => {
    expect(buildAgentCommand("codex", "p", SETTINGS, { effort: 'high" foo="bar' })).toBe(
      `codex 'p'`,
    );
    expect(buildAgentCommand("claude-code", "p", SETTINGS, { effort: "$(id)" })).toBe(
      `${CLAUDE} 'p'`,
    );
  });

  it("ignores permission mode and effort for the other CLIs", () => {
    const o = { permissionMode: "bypassPermissions" as const, effort: "high" };
    expect(buildAgentCommand("cursor", "p", SETTINGS, o)).toBe(`cursor-agent 'p'`);
    expect(buildAgentCommand("gemini", "p", SETTINGS, o)).toBe(`gemini -i 'p'`);
  });
});
