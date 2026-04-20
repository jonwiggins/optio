import { describe, it, expect } from "vitest";
import { CopilotAdapter } from "./copilot.js";

const adapter = new CopilotAdapter();

describe("CopilotAdapter", () => {
  describe("type and displayName", () => {
    it("has correct type", () => {
      expect(adapter.type).toBe("copilot");
    });

    it("has correct displayName", () => {
      expect(adapter.displayName).toBe("GitHub Copilot");
    });
  });

  describe("validateSecrets", () => {
    it("returns valid when COPILOT_GITHUB_TOKEN is present", () => {
      const result = adapter.validateSecrets(["COPILOT_GITHUB_TOKEN"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("reports missing COPILOT_GITHUB_TOKEN", () => {
      const result = adapter.validateSecrets([]);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["COPILOT_GITHUB_TOKEN"]);
    });

    it("reports missing when other secrets are present but not COPILOT_GITHUB_TOKEN", () => {
      const result = adapter.validateSecrets(["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["COPILOT_GITHUB_TOKEN"]);
    });
  });

  describe("buildContainerConfig", () => {
    const baseInput = {
      taskId: "test-123",
      prompt: "Fix the bug",
      repoUrl: "https://github.com/org/repo",
      repoBranch: "main",
    };

    it("uses rendered prompt when available", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        renderedPrompt: "Rendered: Fix the bug",
      });
      expect(config.env.OPTIO_PROMPT).toBe("Rendered: Fix the bug");
    });

    it("falls back to raw prompt when no rendered prompt", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_PROMPT).toBe("Fix the bug");
    });

    it("sets correct env vars", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_TASK_ID).toBe("test-123");
      expect(config.env.OPTIO_AGENT_TYPE).toBe("copilot");
      expect(config.env.OPTIO_BRANCH_NAME).toBe("optio/task-test-123");
      expect(config.env.OPTIO_REPO_URL).toBe("https://github.com/org/repo");
      expect(config.env.OPTIO_REPO_BRANCH).toBe("main");
    });

    it("requires COPILOT_GITHUB_TOKEN secret", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.requiredSecrets).toEqual(["COPILOT_GITHUB_TOKEN"]);
    });

    it("sets COPILOT_MODEL env var when copilotModel is provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        copilotModel: "claude-sonnet-4.5",
      });
      expect(config.env.COPILOT_MODEL).toBe("claude-sonnet-4.5");
    });

    it("sets COPILOT_EFFORT env var when copilotEffort is provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        copilotEffort: "high",
      });
      expect(config.env.COPILOT_EFFORT).toBe("high");
    });

    it("does not set COPILOT_MODEL or COPILOT_EFFORT when not provided", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.COPILOT_MODEL).toBeUndefined();
      expect(config.env.COPILOT_EFFORT).toBeUndefined();
    });

    it("includes setup files when task file is provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        taskFileContent: "# Task\nDo something",
        taskFilePath: ".optio/task.md",
      });
      expect(config.setupFiles).toHaveLength(1);
      expect(config.setupFiles![0].path).toBe(".optio/task.md");
      expect(config.setupFiles![0].content).toBe("# Task\nDo something");
    });

    it("returns empty setupFiles when no task file", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.setupFiles).toEqual([]);
    });

    it("uses entrypoint.sh as command", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.command).toEqual(["/opt/optio/entrypoint.sh"]);
    });
  });

  describe("parseResult", () => {
    it("returns success for exit code 0 with no errors", () => {
      const result = adapter.parseResult(0, "some output\nmore output");
      expect(result.success).toBe(true);
      expect(result.summary).toBe("Agent completed successfully");
      expect(result.error).toBeUndefined();
    });

    it("returns failure for non-zero exit code", () => {
      const result = adapter.parseResult(1, "some output");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Exit code: 1");
    });

    it("extracts PR URL from logs", () => {
      const logs = `Working on task...\nhttps://github.com/org/repo/pull/42\nDone!`;
      const result = adapter.parseResult(0, logs);
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
    });

    it("extracts summary from last assistant message", () => {
      const logs = [
        '{"type":"message","role":"assistant","content":"Starting work"}',
        '{"type":"message","role":"assistant","content":"All done, PR created"}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.summary).toBe("All done, PR created");
    });

    it("truncates long summaries", () => {
      const longMsg = "x".repeat(300);
      const logs = `{"type":"message","role":"assistant","content":"${longMsg}"}`;
      const result = adapter.parseResult(0, logs);
      expect(result.summary!.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    });

    it("uses total_cost_usd when provided directly", () => {
      const logs = '{"type":"result","total_cost_usd":0.0534}';
      const result = adapter.parseResult(0, logs);
      expect(result.costUsd).toBe(0.0534);
    });

    it("detects error events in JSON output", () => {
      const logs = '{"type":"error","message":"Token is invalid"}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Token is invalid");
    });

    it("detects error envelope in JSON output", () => {
      const logs =
        '{"error":{"message":"Subscription required for Copilot","type":"auth_error","code":"subscription_required"}}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Subscription required for Copilot");
    });

    it("detects is_error result events", () => {
      const logs = '{"is_error":true,"result":"Authentication failed"}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Authentication failed");
    });

    it("extracts token usage from events", () => {
      const logs = [
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":1000,"output_tokens":500}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
    });

    it("includes cache_read and cache_creation tokens in input total", () => {
      const logs =
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":50,"output_tokens":200,"cache_creation_input_tokens":1000,"cache_read_input_tokens":5000}}';
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(6050);
      expect(result.outputTokens).toBe(200);
    });

    it("extracts token usage from OpenAI-style naming", () => {
      const logs =
        '{"type":"message","role":"assistant","content":"Done","usage":{"prompt_tokens":2000,"completion_tokens":1000}}';
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(2000);
      expect(result.outputTokens).toBe(1000);
    });

    it("extracts model from events", () => {
      const logs =
        '{"model":"claude-sonnet-4.5","type":"message","role":"assistant","content":"Hi"}';
      const result = adapter.parseResult(0, logs);
      expect(result.model).toBe("claude-sonnet-4.5");
    });

    it("detects auth errors in raw text", () => {
      const logs = "Error: COPILOT_GITHUB_TOKEN authentication failed";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("COPILOT_GITHUB_TOKEN");
    });

    it("detects subscription errors in raw text", () => {
      const logs = "subscription required for this feature";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("subscription");
    });

    it("detects model not found errors in raw text", () => {
      const logs = "Error: model_not_found - The model does not exist";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("model_not_found");
    });

    it("detects server errors in raw text", () => {
      const logs = "Error: 503 service unavailable";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("503");
    });

    it("handles empty logs gracefully", () => {
      const result = adapter.parseResult(0, "");
      expect(result.success).toBe(true);
      expect(result.costUsd).toBeUndefined();
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.model).toBeUndefined();
    });

    it("does not compute cost from tokens (subscription-based)", () => {
      const logs =
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":1000,"output_tokens":500}}';
      const result = adapter.parseResult(0, logs);
      // Copilot is subscription-based — no per-token cost calculation
      expect(result.costUsd).toBeUndefined();
    });
  });
});
