import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for task-worker pure functions:
 * - buildAgentCommand: constructs the CLI command for different agent types
 * - inferExitCode: determines success/failure from agent log output
 *
 * These are the core decision-making functions in the task worker that
 * determine how agents are invoked and whether they succeeded.
 */

// Mock all heavy dependencies so we can import the pure functions
vi.mock("bullmq", () => ({
  Worker: vi.fn(),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    getJobs: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}));

vi.mock("../db/schema.js", () => ({
  tasks: { state: "state", repoUrl: "repoUrl", id: "id" },
}));

vi.mock("../services/task-service.js", () => ({
  getTask: vi.fn(),
  tryTransitionTask: vi.fn(),
  transitionTask: vi.fn(),
  updateTaskContainer: vi.fn(),
  updateTaskSession: vi.fn(),
  appendTaskLog: vi.fn(),
  updateTaskPr: vi.fn(),
  updateTaskResult: vi.fn(),
  touchTaskHeartbeat: vi.fn(),
  StateRaceError: class StateRaceError extends Error {},
}));

vi.mock("../services/repo-pool-service.js", () => ({
  getOrCreateRepoPod: vi.fn(),
  execTaskInRepoPod: vi.fn(),
  releaseRepoPodTask: vi.fn(),
}));

vi.mock("../services/event-bus.js", () => ({
  publishEvent: vi.fn(),
}));

vi.mock("../services/secret-service.js", () => ({
  resolveSecretsForTask: vi.fn().mockResolvedValue({}),
  retrieveSecret: vi.fn().mockResolvedValue("api-key"),
}));

vi.mock("../services/prompt-template-service.js", () => ({
  getPromptTemplate: vi.fn().mockResolvedValue({ template: "test", autoMerge: false }),
}));

vi.mock("../logger.js", () => ({
  logger: {
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../services/agent-event-parser.js", () => ({
  parseClaudeEvent: vi.fn().mockReturnValue({ entries: [], sessionId: null }),
}));

vi.mock("../services/codex-event-parser.js", () => ({
  parseCodexEvent: vi.fn().mockReturnValue({ entries: [], sessionId: null }),
}));

import { buildAgentCommand, inferExitCode } from "./task-worker.js";

describe("buildAgentCommand", () => {
  describe("claude-code agent", () => {
    it("builds basic claude command with prompt and default max turns", () => {
      const env = { OPTIO_PROMPT: "Fix the bug" };
      const cmd = buildAgentCommand("claude-code", env);

      expect(cmd.some((line) => line.includes("claude -p"))).toBe(true);
      expect(cmd.some((line) => line.includes("--dangerously-skip-permissions"))).toBe(true);
      expect(cmd.some((line) => line.includes("--output-format stream-json"))).toBe(true);
      expect(cmd.some((line) => line.includes("--verbose"))).toBe(true);
      expect(cmd.some((line) => line.includes("--max-turns"))).toBe(true);
    });

    it("uses default coding max turns (250)", () => {
      const env = { OPTIO_PROMPT: "Do something" };
      const cmd = buildAgentCommand("claude-code", env);

      const maxTurnsLine = cmd.find((line) => line.includes("--max-turns"));
      expect(maxTurnsLine).toContain("250");
    });

    it("uses review max turns (10) for review tasks", () => {
      const env = { OPTIO_PROMPT: "Review the PR" };
      const cmd = buildAgentCommand("claude-code", env, { isReview: true });

      const maxTurnsLine = cmd.find((line) => line.includes("--max-turns"));
      expect(maxTurnsLine).toContain("10");
    });

    it("allows overriding max turns for coding", () => {
      const env = { OPTIO_PROMPT: "Do something" };
      const cmd = buildAgentCommand("claude-code", env, { maxTurnsCoding: 50 });

      const maxTurnsLine = cmd.find((line) => line.includes("--max-turns"));
      expect(maxTurnsLine).toContain("50");
    });

    it("allows overriding max turns for review", () => {
      const env = { OPTIO_PROMPT: "Review" };
      const cmd = buildAgentCommand("claude-code", env, {
        isReview: true,
        maxTurnsReview: 25,
      });

      const maxTurnsLine = cmd.find((line) => line.includes("--max-turns"));
      expect(maxTurnsLine).toContain("25");
    });

    it("includes resume flag when resumeSessionId is provided", () => {
      const env = { OPTIO_PROMPT: "Continue" };
      const cmd = buildAgentCommand("claude-code", env, {
        resumeSessionId: "session-abc-123",
      });

      expect(cmd.some((line) => line.includes("--resume"))).toBe(true);
      expect(cmd.some((line) => line.includes("session-abc-123"))).toBe(true);
    });

    it("uses resumePrompt when provided instead of OPTIO_PROMPT", () => {
      const env = { OPTIO_PROMPT: "Original prompt" };
      const cmd = buildAgentCommand("claude-code", env, {
        resumePrompt: "Fix the failing tests",
      });

      expect(cmd.some((line) => line.includes("Fix the failing tests"))).toBe(true);
    });

    it("adds auth setup for max-subscription mode", () => {
      const env = {
        OPTIO_PROMPT: "Fix bug",
        OPTIO_AUTH_MODE: "max-subscription",
        OPTIO_API_URL: "http://localhost:4000",
      };
      const cmd = buildAgentCommand("claude-code", env);

      expect(cmd.some((line) => line.includes("Token proxy OK"))).toBe(true);
      expect(cmd.some((line) => line.includes("unset ANTHROPIC_API_KEY"))).toBe(true);
    });

    it("does not add auth setup for api-key mode", () => {
      const env = { OPTIO_PROMPT: "Fix bug", OPTIO_AUTH_MODE: "api-key" };
      const cmd = buildAgentCommand("claude-code", env);

      expect(cmd.some((line) => line.includes("Token proxy OK"))).toBe(false);
    });

    it("includes review indicator in echo for review tasks", () => {
      const env = { OPTIO_PROMPT: "Review" };
      const cmd = buildAgentCommand("claude-code", env, { isReview: true });

      expect(cmd.some((line) => line.includes("(review)"))).toBe(true);
    });
  });

  describe("codex agent", () => {
    it("builds codex command", () => {
      const env = { OPTIO_PROMPT: "Fix the bug" };
      const cmd = buildAgentCommand("codex", env);

      expect(cmd.some((line) => line.includes("codex exec"))).toBe(true);
      expect(cmd.some((line) => line.includes("--full-auto"))).toBe(true);
      expect(cmd.some((line) => line.includes("--json"))).toBe(true);
    });
  });

  describe("unknown agent", () => {
    it("outputs error for unknown agent type", () => {
      const env = { OPTIO_PROMPT: "something" };
      const cmd = buildAgentCommand("unknown-agent", env);

      expect(cmd.some((line) => line.includes("Unknown agent type"))).toBe(true);
      expect(cmd.some((line) => line.includes("exit 1"))).toBe(true);
    });
  });
});

describe("inferExitCode", () => {
  describe("claude-code", () => {
    it("returns 0 for clean output", () => {
      const logs = '{"type":"assistant","content":"Hello"}\n{"type":"result","is_error":false}';
      expect(inferExitCode("claude-code", logs)).toBe(0);
    });

    it("returns 1 when is_error is true in result", () => {
      const logs = '{"type":"result","is_error":true}';
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 1 on fatal git error", () => {
      const logs = "fatal: unable to access repo";
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 1 on authentication failure", () => {
      const logs = "Error: authentication_failed — token expired";
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 1 on exit 1 in logs", () => {
      const logs = "some output\nexit 1\nmore output";
      expect(inferExitCode("claude-code", logs)).toBe(1);
    });

    it("returns 0 when none of the error patterns match", () => {
      const logs = '{"type":"assistant"}\n{"type":"result","is_error":false}\nDone.';
      expect(inferExitCode("claude-code", logs)).toBe(0);
    });
  });

  describe("codex", () => {
    it("returns 0 for clean codex output", () => {
      const logs = '{"type":"message","content":"Done"}';
      expect(inferExitCode("codex", logs)).toBe(0);
    });

    it("returns 1 on error event", () => {
      const logs = '{"type":"error","message":"something went wrong"}';
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on error event with spaces in JSON", () => {
      const logs = '{"type": "error", "message": "failed"}';
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on OPENAI_API_KEY error", () => {
      const logs = "Error: OPENAI_API_KEY is not set";
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on authentication failure", () => {
      const logs = "unauthorized: invalid api key provided";
      expect(inferExitCode("codex", logs)).toBe(1);
    });

    it("returns 1 on quota error", () => {
      const logs = "Error: insufficient_quota — billing limit reached";
      expect(inferExitCode("codex", logs)).toBe(1);
    });
  });

  describe("unknown agent type (falls through to claude default)", () => {
    it("uses claude-code patterns for unknown types", () => {
      expect(inferExitCode("something-else", "fatal: error")).toBe(1);
      expect(inferExitCode("something-else", "all good")).toBe(0);
    });
  });
});
