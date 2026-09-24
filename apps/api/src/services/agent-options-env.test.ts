import { describe, it, expect } from "vitest";
import { agentOptionsEnv } from "./agent-options-env.js";
import { buildPooledAgentCommand, codexModelFlags } from "./pooled-agent-command.js";

describe("agentOptionsEnv", () => {
  it("maps Claude Code options onto model, context window, and settings JSON", () => {
    const env = agentOptionsEnv("claude-code", {
      claudeModel: "claude-opus-4-8",
      claudeContextWindow: "1m",
      claudeEffort: "medium",
      claudeThinking: false,
    });
    expect(env.OPTIO_CLAUDE_MODEL).toBe("claude-opus-4-8");
    expect(env.OPTIO_CLAUDE_CONTEXT_WINDOW).toBe("1m");
    expect(JSON.parse(env.OPTIO_CLAUDE_SETTINGS_JSON)).toEqual({
      effortLevel: "medium",
      alwaysThinkingEnabled: false,
    });
  });

  it("falls back to the legacy model column when options carry no model", () => {
    expect(agentOptionsEnv("claude-code", null, "sonnet").OPTIO_CLAUDE_MODEL).toBe("sonnet");
    expect(agentOptionsEnv("claude-code", { claudeEffort: "low" }, "haiku")).toMatchObject({
      OPTIO_CLAUDE_MODEL: "haiku",
    });
  });

  it("prefers the options' model over the legacy column and ignores blanks", () => {
    const env = agentOptionsEnv("claude-code", { claudeModel: "opus", claudeEffort: "" }, "sonnet");
    expect(env.OPTIO_CLAUDE_MODEL).toBe("opus");
    expect(env.OPTIO_CLAUDE_SETTINGS_JSON).toBeUndefined();
  });

  it("emits nothing for empty options", () => {
    expect(agentOptionsEnv("claude-code", {})).toEqual({});
    expect(agentOptionsEnv("gemini", null)).toEqual({});
  });

  it("maps the other runtimes onto their own env names", () => {
    expect(agentOptionsEnv("copilot", { copilotModel: "gpt-5", copilotEffort: "high" })).toEqual({
      COPILOT_MODEL: "gpt-5",
      COPILOT_EFFORT: "high",
    });
    // Codex shares Copilot's columns but has its own env names.
    expect(agentOptionsEnv("codex", { copilotModel: "gpt-5-codex" })).toEqual({
      OPTIO_CODEX_MODEL: "gpt-5-codex",
    });
    expect(
      agentOptionsEnv("codex", { copilotModel: "gpt-5.6-sol", copilotEffort: "xhigh" }),
    ).toEqual({ OPTIO_CODEX_MODEL: "gpt-5.6-sol", OPTIO_CODEX_EFFORT: "xhigh" });
    expect(
      agentOptionsEnv("opencode", {
        opencodeModel: "anthropic/claude-sonnet-4",
        opencodeAgent: "plan",
      }),
    ).toEqual({ OPTIO_OPENCODE_MODEL: "anthropic/claude-sonnet-4", OPTIO_OPENCODE_AGENT: "plan" });
    expect(
      agentOptionsEnv("gemini", { geminiModel: "gemini-2.5-pro", geminiApprovalMode: "auto_edit" }),
    ).toEqual({ OPTIO_GEMINI_MODEL: "gemini-2.5-pro", OPTIO_GEMINI_APPROVAL_MODE: "auto_edit" });
    expect(agentOptionsEnv("cursor", { cursorModel: "auto" })).toEqual({
      OPTIO_CURSOR_MODEL: "auto",
    });
  });
});

describe("buildPooledAgentCommand", () => {
  const opts = { maxTurns: 10, label: "test run" };

  it("passes Claude settings as a --settings JSON flag next to --model", () => {
    const cmds = buildPooledAgentCommand(
      "claude-code",
      agentOptionsEnv("claude-code", {
        claudeModel: "opus",
        claudeContextWindow: "1m",
        claudeEffort: "high",
        claudeThinking: true,
      }),
      opts,
    );
    const last = cmds[cmds.length - 1];
    expect(last).toContain("--model opus[1m]");
    expect(last).toContain(
      `--settings "{\\"effortLevel\\":\\"high\\",\\"alwaysThinkingEnabled\\":true}"`,
    );
    expect(cmds.join("\n")).toContain("--max-turns 10");
  });

  it("leaves the flag line empty when nothing is set", () => {
    const cmds = buildPooledAgentCommand("claude-code", {}, opts);
    expect(cmds[cmds.length - 1]).toBe("");
  });

  it("adds --effort, --agent, and --approval-mode for the other runtimes", () => {
    expect(
      buildPooledAgentCommand(
        "copilot",
        { COPILOT_MODEL: "gpt-5", COPILOT_EFFORT: "low" },
        opts,
      ).join("\n"),
    ).toContain(`--model "gpt-5" --effort "low"`);
    expect(
      buildPooledAgentCommand("opencode", { OPTIO_OPENCODE_AGENT: "plan" }, opts).join("\n"),
    ).toContain(`--agent "plan"`);
    expect(
      buildPooledAgentCommand("gemini", { OPTIO_GEMINI_APPROVAL_MODE: "yolo" }, opts).join("\n"),
    ).toContain(`gemini --approval-mode "yolo" -p`);
  });

  it("labels the echo line with the caller's label", () => {
    expect(buildPooledAgentCommand("codex", {}, opts)[0]).toContain("Running test run (Codex)");
  });

  it("passes Codex its model and reasoning effort", () => {
    const env = agentOptionsEnv("codex", { copilotModel: "gpt-5.6-sol", copilotEffort: "high" });
    expect(buildPooledAgentCommand("codex", env, opts)[1]).toBe(
      `codex exec --full-auto -m 'gpt-5.6-sol' -c 'model_reasoning_effort="high"' "$OPTIO_PROMPT" --json`,
    );
    // Nothing set: Codex's own defaults, as before.
    expect(buildPooledAgentCommand("codex", {}, opts)[1]).toBe(
      `codex exec --full-auto "$OPTIO_PROMPT" --json`,
    );
  });

  it("shell-quotes the Codex model and drops an effort that isn't a word", () => {
    expect(
      codexModelFlags({ OPTIO_CODEX_MODEL: "x'; rm -rf / #", OPTIO_CODEX_EFFORT: 'hi" y="z' }),
    ).toBe(` -m 'x'\\''; rm -rf / #'`);
  });
});
