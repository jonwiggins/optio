import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("../db/client.js", () => {
  const mockSelect = vi.fn().mockReturnThis();
  const mockFrom = vi.fn().mockReturnThis();
  const mockWhere = vi.fn().mockReturnThis();
  const mockUpdate = vi.fn().mockReturnThis();
  const mockSet = vi.fn().mockReturnThis();
  const mockReturning = vi.fn().mockResolvedValue([]);
  const mockInsert = vi.fn().mockReturnThis();
  const mockValues = vi.fn().mockReturnThis();

  return {
    db: {
      select: mockSelect,
      from: mockFrom,
      where: mockWhere,
      update: mockUpdate,
      set: mockSet,
      returning: mockReturning,
      insert: mockInsert,
      values: mockValues,
    },
  };
});

vi.mock("../db/schema.js", () => ({
  workflowRuns: { id: "id", workflowId: "workflow_id", state: "state" },
  workflows: { id: "id" },
  workflowPods: { id: "id" },
}));

vi.mock("../services/redis-config.js", () => ({
  getBullMQConnectionOptions: () => ({ url: "redis://localhost:6379", maxRetriesPerRequest: null }),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  })),
  Worker: vi.fn().mockImplementation((_name: string, _fn: unknown, _opts: unknown) => ({
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../services/workflow-service.js", () => ({
  getWorkflow: vi.fn(),
  getWorkflowRun: vi.fn(),
}));

vi.mock("../services/workflow-pool-service.js", () => ({
  getOrCreateWorkflowPod: vi.fn(),
  execRunInPod: vi.fn(),
  releaseRun: vi.fn(),
}));

vi.mock("../services/agent-event-parser.js", () => ({
  parseClaudeEvent: vi.fn().mockReturnValue({ entries: [], sessionId: undefined }),
}));

vi.mock("../services/event-bus.js", () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/secret-service.js", () => ({
  resolveSecretsForTask: vi.fn().mockResolvedValue({}),
  retrieveSecretWithFallback: vi.fn().mockResolvedValue(null),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Import after mocks
import { buildWorkflowAgentCommand, renderWorkflowPrompt } from "./workflow-worker.js";

describe("renderWorkflowPrompt", () => {
  it("replaces param variables in the template", () => {
    const template = "Analyze {{repo}} and fix {{issue}}";
    const params = { repo: "my-app", issue: "bug #42" };
    const result = renderWorkflowPrompt(template, params);
    expect(result).toBe("Analyze my-app and fix bug #42");
  });

  it("leaves unknown variables as-is", () => {
    const template = "Process {{known}} and {{unknown}}";
    const params = { known: "value" };
    const result = renderWorkflowPrompt(template, params);
    expect(result).toBe("Process value and {{unknown}}");
  });

  it("handles empty params", () => {
    const template = "No params here";
    const result = renderWorkflowPrompt(template, {});
    expect(result).toBe("No params here");
  });

  it("handles null/undefined params", () => {
    const template = "No params here";
    const result = renderWorkflowPrompt(template, undefined);
    expect(result).toBe("No params here");
  });

  it("converts non-string param values to strings", () => {
    const template = "Count: {{count}}, active: {{active}}";
    const params = { count: 42, active: true };
    const result = renderWorkflowPrompt(template, params);
    expect(result).toBe("Count: 42, active: true");
  });
});

describe("buildWorkflowAgentCommand", () => {
  describe("claude-code agent", () => {
    it("produces a claude command with stream-json output", () => {
      const cmds = buildWorkflowAgentCommand("claude-code", {
        OPTIO_PROMPT: "Run analysis",
      });

      expect(cmds.some((c) => c.includes("claude --print"))).toBe(true);
      expect(cmds.some((c) => c.includes("--dangerously-skip-permissions"))).toBe(true);
      expect(cmds.some((c) => c.includes("--output-format stream-json"))).toBe(true);
      expect(cmds.some((c) => c.includes("--verbose"))).toBe(true);
    });

    it("uses workflow maxTurns when specified", () => {
      const cmds = buildWorkflowAgentCommand(
        "claude-code",
        {
          OPTIO_PROMPT: "Do work",
        },
        { maxTurns: 50 },
      );
      expect(cmds.some((c) => c.includes("--max-turns 50"))).toBe(true);
    });

    it("defaults to 250 max turns when not specified", () => {
      const cmds = buildWorkflowAgentCommand("claude-code", {
        OPTIO_PROMPT: "Do work",
      });
      expect(cmds.some((c) => c.includes("--max-turns 250"))).toBe(true);
    });

    it("adds --model flag when OPTIO_CLAUDE_MODEL is set", () => {
      const cmds = buildWorkflowAgentCommand("claude-code", {
        OPTIO_PROMPT: "Do work",
        OPTIO_CLAUDE_MODEL: "sonnet",
      });
      expect(cmds.some((c) => c.includes("--model sonnet"))).toBe(true);
    });

    it("does not embed the prompt in the command", () => {
      const cmds = buildWorkflowAgentCommand("claude-code", {
        OPTIO_PROMPT: "SECRET PROMPT TEXT",
      });
      const joined = cmds.join("\n");
      expect(joined).not.toContain("SECRET PROMPT TEXT");
    });
  });

  describe("codex agent", () => {
    it("produces a codex exec command", () => {
      const cmds = buildWorkflowAgentCommand("codex", {
        OPTIO_PROMPT: "Build feature",
      });
      expect(cmds.some((c) => c.includes("codex exec"))).toBe(true);
      expect(cmds.some((c) => c.includes("--full-auto"))).toBe(true);
    });
  });

  describe("unknown agent", () => {
    it("produces an error for unknown agent types", () => {
      const cmds = buildWorkflowAgentCommand("unknown-agent", {
        OPTIO_PROMPT: "Do something",
      });
      expect(cmds.some((c) => c.includes("Unknown agent type"))).toBe(true);
      expect(cmds.some((c) => c.includes("exit 1"))).toBe(true);
    });
  });
});
