import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAgentCommand,
  buildInitialClaudeStreamMessage,
  inferExitCode,
  shouldEscalateNoPr,
} from "./task-worker.js";

describe("buildAgentCommand", () => {
  describe("claude-code agent", () => {
    it("produces a basic claude command that runs in --print mode", () => {
      const env = { OPTIO_PROMPT: "Fix the bug" };
      const cmds = buildAgentCommand("claude-code", env);

      expect(cmds.some((c) => c.includes("claude --print"))).toBe(true);
      expect(cmds.some((c) => c.includes("--dangerously-skip-permissions"))).toBe(true);
      expect(cmds.some((c) => c.includes("--output-format stream-json"))).toBe(true);
      expect(cmds.some((c) => c.includes("--verbose"))).toBe(true);
      expect(cmds.some((c) => c.includes("--max-turns 250"))).toBe(true);
    });

    // Regression test for the stream-json stdin bug: with --input-format
    // stream-json, claude ignores the -p positional arg, so the prompt must
    // arrive via stdin. The command itself must not embed the prompt — if it
    // does, it's either useless (ignored) or a hint that someone re-introduced
    // the broken invocation.
    it("does not embed the prompt in the claude command (delivered via stdin)", () => {
      const env = { OPTIO_PROMPT: "DO NOT EMBED THIS TEXT" };
      const cmds = buildAgentCommand("claude-code", env);
      const joined = cmds.join("\n");
      expect(joined).not.toContain("DO NOT EMBED THIS TEXT");
      expect(joined).not.toContain("$OPTIO_PROMPT");
      expect(joined).not.toMatch(/claude\s+-p\b/);
    });

    it("uses default coding max turns (250)", () => {
      const env = { OPTIO_PROMPT: "Do stuff" };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("--max-turns 250"))).toBe(true);
    });

    it("uses default review max turns (30) when isReview is true", () => {
      const env = { OPTIO_PROMPT: "Review PR" };
      const cmds = buildAgentCommand("claude-code", env, { isReview: true });
      expect(cmds.some((c) => c.includes("--max-turns 30"))).toBe(true);
    });

    it("respects custom maxTurnsCoding override", () => {
      const env = { OPTIO_PROMPT: "Build feature" };
      const cmds = buildAgentCommand("claude-code", env, { maxTurnsCoding: 100 });
      expect(cmds.some((c) => c.includes("--max-turns 100"))).toBe(true);
    });

    it("respects custom maxTurnsReview override for reviews", () => {
      const env = { OPTIO_PROMPT: "Review code" };
      const cmds = buildAgentCommand("claude-code", env, {
        isReview: true,
        maxTurnsReview: 25,
      });
      expect(cmds.some((c) => c.includes("--max-turns 25"))).toBe(true);
    });

    it("adds resume flag when resumeSessionId is provided", () => {
      const env = { OPTIO_PROMPT: "Continue work" };
      const cmds = buildAgentCommand("claude-code", env, {
        resumeSessionId: "sess-abc-123",
      });
      expect(cmds.some((c) => c.includes("--resume"))).toBe(true);
      expect(cmds.some((c) => c.includes("sess-abc-123"))).toBe(true);
    });

    it("uses resumePrompt with original prompt as context when provided", () => {
      const env = { OPTIO_PROMPT: "Original prompt" };
      buildAgentCommand("claude-code", env, {
        resumePrompt: "Fix the tests now",
      });
      // The prompt is mutated in env.OPTIO_PROMPT (passed via $OPTIO_PROMPT in the script)
      expect(env.OPTIO_PROMPT).toContain("Fix the tests now");
      expect(env.OPTIO_PROMPT).toContain("Original prompt");
    });

    it("adds max-subscription auth setup when auth mode is max-subscription", () => {
      const env = {
        OPTIO_PROMPT: "Do work",
        OPTIO_AUTH_MODE: "max-subscription",
        OPTIO_API_URL: "http://localhost:4000",
      };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("Token proxy OK"))).toBe(true);
      expect(cmds.some((c) => c.includes("unset ANTHROPIC_API_KEY"))).toBe(true);
    });

    it("does not add auth setup for api-key mode", () => {
      const env = { OPTIO_PROMPT: "Do work", OPTIO_AUTH_MODE: "api-key" };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("Token proxy OK"))).toBe(false);
      expect(cmds.some((c) => c.includes("unset ANTHROPIC_API_KEY"))).toBe(false);
    });

    it("includes review label in echo when isReview is true", () => {
      const env = { OPTIO_PROMPT: "Review" };
      const cmds = buildAgentCommand("claude-code", env, { isReview: true });
      expect(cmds.some((c) => c.includes("(review)"))).toBe(true);
    });

    it("adds --model flag when OPTIO_CLAUDE_MODEL is set", () => {
      const env = { OPTIO_PROMPT: "Do work", OPTIO_CLAUDE_MODEL: "opus" };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("--model opus"))).toBe(true);
    });

    it("adds context window suffix to --model flag", () => {
      const env = {
        OPTIO_PROMPT: "Do work",
        OPTIO_CLAUDE_MODEL: "opus",
        OPTIO_CLAUDE_CONTEXT_WINDOW: "1m",
      };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("--model opus[1m]"))).toBe(true);
    });

    it("does not add --model flag when OPTIO_CLAUDE_MODEL is not set", () => {
      const env = { OPTIO_PROMPT: "Do work" };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("--model"))).toBe(false);
    });

    it("includes --input-format stream-json for mid-task messaging support", () => {
      const env = { OPTIO_PROMPT: "Fix the bug" };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("--input-format stream-json"))).toBe(true);
    });

    it("includes --replay-user-messages for message acknowledgment", () => {
      const env = { OPTIO_PROMPT: "Fix the bug" };
      const cmds = buildAgentCommand("claude-code", env);
      expect(cmds.some((c) => c.includes("--replay-user-messages"))).toBe(true);
    });

    it("does not include stream-json flags for codex agent", () => {
      const env = { OPTIO_PROMPT: "Build feature" };
      const cmds = buildAgentCommand("codex", env);
      expect(cmds.some((c) => c.includes("--input-format stream-json"))).toBe(false);
      expect(cmds.some((c) => c.includes("--replay-user-messages"))).toBe(false);
    });
  });

  describe("codex agent", () => {
    it("produces a codex exec command", () => {
      const env = { OPTIO_PROMPT: "Build feature" };
      const cmds = buildAgentCommand("codex", env);
      expect(cmds.some((c) => c.includes("codex exec"))).toBe(true);
      expect(cmds.some((c) => c.includes("--full-auto"))).toBe(true);
      expect(cmds.some((c) => c.includes("--json"))).toBe(true);
    });

    it("does not include --app-server flag in api-key mode", () => {
      const env = { OPTIO_PROMPT: "Build feature", OPTIO_CODEX_AUTH_MODE: "api-key" };
      const cmds = buildAgentCommand("codex", env);
      expect(cmds.some((c) => c.includes("--app-server"))).toBe(false);
    });

    it("includes --app-server flag with URL in app-server mode", () => {
      const env = {
        OPTIO_PROMPT: "Build feature",
        OPTIO_CODEX_AUTH_MODE: "app-server",
        OPTIO_CODEX_APP_SERVER_URL: "ws://localhost:3900/v1/connect",
      };
      const cmds = buildAgentCommand("codex", env);
      expect(cmds.some((c) => c.includes("--app-server"))).toBe(true);
      expect(cmds.some((c) => c.includes("ws://localhost:3900/v1/connect"))).toBe(true);
    });

    it("includes app-server label in echo when in app-server mode", () => {
      const env = {
        OPTIO_PROMPT: "Build feature",
        OPTIO_CODEX_AUTH_MODE: "app-server",
        OPTIO_CODEX_APP_SERVER_URL: "ws://localhost:3900/v1/connect",
      };
      const cmds = buildAgentCommand("codex", env);
      expect(cmds.some((c) => c.includes("(app-server)"))).toBe(true);
    });

    it("does not include --app-server flag when auth mode is app-server but URL is missing", () => {
      const env = { OPTIO_PROMPT: "Build feature", OPTIO_CODEX_AUTH_MODE: "app-server" };
      const cmds = buildAgentCommand("codex", env);
      expect(cmds.some((c) => c.includes("--app-server"))).toBe(false);
    });
  });

  describe("opencode agent", () => {
    it("produces an opencode run command with --format json", () => {
      const env = { OPTIO_PROMPT: "Fix the bug" };
      const cmds = buildAgentCommand("opencode", env);
      expect(cmds.some((c) => c.includes("opencode run"))).toBe(true);
      expect(cmds.some((c) => c.includes("--format json"))).toBe(true);
    });

    it("includes experimental label in echo", () => {
      const env = { OPTIO_PROMPT: "Fix the bug" };
      const cmds = buildAgentCommand("opencode", env);
      expect(cmds.some((c) => c.includes("(experimental)"))).toBe(true);
    });

    it("adds --model flag when OPTIO_OPENCODE_MODEL is set", () => {
      const env = {
        OPTIO_PROMPT: "Fix the bug",
        OPTIO_OPENCODE_MODEL: "anthropic/claude-sonnet-4",
      };
      const cmds = buildAgentCommand("opencode", env);
      expect(cmds.some((c) => c.includes("--model"))).toBe(true);
      expect(cmds.some((c) => c.includes("anthropic/claude-sonnet-4"))).toBe(true);
    });

    it("adds --agent flag when OPTIO_OPENCODE_AGENT is set", () => {
      const env = { OPTIO_PROMPT: "Fix the bug", OPTIO_OPENCODE_AGENT: "build" };
      const cmds = buildAgentCommand("opencode", env);
      expect(cmds.some((c) => c.includes("--agent"))).toBe(true);
      expect(cmds.some((c) => c.includes("build"))).toBe(true);
    });

    it("does not add --model or --agent flags when not set", () => {
      const env = { OPTIO_PROMPT: "Fix the bug" };
      const cmds = buildAgentCommand("opencode", env);
      expect(cmds.some((c) => c.includes("--model"))).toBe(false);
      expect(cmds.some((c) => c.includes("--agent"))).toBe(false);
    });

    it("adds --session flag for resume", () => {
      const env = { OPTIO_PROMPT: "Continue work" };
      const cmds = buildAgentCommand("opencode", env, {
        resumeSessionId: "oc-sess-abc",
      });
      expect(cmds.some((c) => c.includes("--session"))).toBe(true);
      expect(cmds.some((c) => c.includes("oc-sess-abc"))).toBe(true);
    });
  });

  describe("unknown agent", () => {
    it("produces an error exit command for unknown agent types", () => {
      const env = { OPTIO_PROMPT: "Do something" };
      const cmds = buildAgentCommand("unknown-agent", env);
      expect(cmds.some((c) => c.includes("Unknown agent type"))).toBe(true);
      expect(cmds.some((c) => c.includes("exit 1"))).toBe(true);
    });
  });
});

describe("buildInitialClaudeStreamMessage", () => {
  it("wraps the prompt as a stream-json user message with a trailing newline", () => {
    const line = buildInitialClaudeStreamMessage("Fix the bug");
    expect(line.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "Fix the bug" }],
      },
    });
  });

  it("preserves newlines and quotes inside the prompt via JSON encoding", () => {
    const prompt = 'line one\nline "two"\nline\tthree';
    const line = buildInitialClaudeStreamMessage(prompt);
    // Exactly one NDJSON line — no embedded literal newlines in the JSON body
    expect(line.split("\n").filter((s) => s.length > 0)).toHaveLength(1);

    const parsed = JSON.parse(line);
    expect(parsed.message.content[0].text).toBe(prompt);
  });

  it("handles an empty prompt without throwing", () => {
    const line = buildInitialClaudeStreamMessage("");
    const parsed = JSON.parse(line);
    expect(parsed.message.content[0].text).toBe("");
  });
});

describe("inferExitCode", () => {
  describe("claude-code", () => {
    it("returns 0 for clean logs", () => {
      const logs = '{"type":"assistant","content":"All done"}\n';
      expect(inferExitCode("claude-code", logs)).toBe(0);
    });

    it("returns 1 when is_error is true in result", () => {
      const logs = '{"type":"result","is_error":true,"error":"Something failed"}\n';
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 1 on fatal git error", () => {
      const logs = "fatal: repository not found\n";
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 1 on authentication_failed error", () => {
      const logs = "Error: authentication_failed - token expired\n";
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 0 when exit 1 appears in logs (not a real error signal)", () => {
      const logs = "some output\nexit 1\nmore output\n";
      expect(inferExitCode("claude-code", logs)).toBe(0);
    });

    it("returns 0 when logs contain non-fatal content", () => {
      const logs = '{"type":"result","is_error":false}\nCompleted successfully\n';
      expect(inferExitCode("claude-code", logs)).toBe(0);
    });
  });

  describe("codex", () => {
    it("returns 0 for clean codex logs", () => {
      const logs = '{"type":"message","content":"Done"}\n';
      expect(inferExitCode("codex", logs)).toBe(0);
    });

    it("returns 1 when error event is present", () => {
      const logs = '{"type":"error","message":"something broke"}\n';
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 when error event has spaces in JSON", () => {
      const logs = '{"type": "error", "message": "broke"}\n';
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on OPENAI_API_KEY auth error", () => {
      const logs = "Error: OPENAI_API_KEY is not set\n";
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on invalid API key", () => {
      const logs = "invalid api key provided\n";
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on quota exceeded", () => {
      const logs = "Error: insufficient_quota - you have exceeded your billing limit\n";
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on billing error", () => {
      const logs = "billing limit exceeded\n";
      expect(inferExitCode("codex", logs)).toBe(1);
    });
  });

  describe("opencode", () => {
    it("returns 0 for clean opencode logs", () => {
      const logs = '{"type":"message","role":"assistant","content":"Done"}\n';
      expect(inferExitCode("opencode", logs)).toBe(0);
    });

    it("returns 1 when error event is present", () => {
      const logs = '{"type":"error","message":"something broke"}\n';
      expect(inferExitCode("opencode", logs)).toBe(1);
    });

    it("returns 1 on ANTHROPIC_API_KEY auth error", () => {
      const logs = "Error: ANTHROPIC_API_KEY is not set\n";
      expect(inferExitCode("opencode", logs)).toBe(1);
    });

    it("returns 1 on OPENAI_API_KEY auth error", () => {
      const logs = "Error: OPENAI_API_KEY is invalid\n";
      expect(inferExitCode("opencode", logs)).toBe(1);
    });

    it("returns 1 on model not found", () => {
      const logs = "model_not_found: the specified model does not exist\n";
      expect(inferExitCode("opencode", logs)).toBe(1);
    });

    it("returns 1 on fatal error", () => {
      const logs = "fatal: repository not found\n";
      expect(inferExitCode("opencode", logs)).toBe(1);
    });
  });

  describe("default (unknown agent type)", () => {
    it("uses claude-code patterns as default", () => {
      expect(inferExitCode("some-future-agent", "fatal: error")).toBe(1);
      expect(inferExitCode("some-future-agent", "all good")).toBe(0);
    });
  });
});

describe("shouldEscalateNoPr", () => {
  const defaults = {
    success: true,
    isReviewTask: false,
    isPlanningRun: false,
    hasRepoUrl: true,
    detectedPrUrl: undefined as string | undefined | null,
  };

  it("escalates when a repo task succeeds without a PR", () => {
    expect(shouldEscalateNoPr(defaults)).toBe(true);
  });

  it("does not escalate when a PR was detected", () => {
    expect(
      shouldEscalateNoPr({ ...defaults, detectedPrUrl: "https://github.com/org/repo/pull/42" }),
    ).toBe(false);
  });

  it("does not escalate when the agent failed", () => {
    expect(shouldEscalateNoPr({ ...defaults, success: false })).toBe(false);
  });

  it("does not escalate for review tasks", () => {
    expect(shouldEscalateNoPr({ ...defaults, isReviewTask: true })).toBe(false);
  });

  it("does not escalate for planning runs", () => {
    expect(shouldEscalateNoPr({ ...defaults, isPlanningRun: true })).toBe(false);
  });

  it("does not escalate for standalone tasks (no repo)", () => {
    expect(shouldEscalateNoPr({ ...defaults, hasRepoUrl: false })).toBe(false);
  });

  it("does not escalate when detectedPrUrl is null", () => {
    // null is treated as falsy — same as undefined
    expect(shouldEscalateNoPr({ ...defaults, detectedPrUrl: null })).toBe(true);
  });

  it("does not escalate when all exemptions apply simultaneously", () => {
    expect(
      shouldEscalateNoPr({
        success: false,
        isReviewTask: true,
        isPlanningRun: true,
        hasRepoUrl: false,
        detectedPrUrl: "https://github.com/org/repo/pull/1",
      }),
    ).toBe(false);
  });
});
