import { describe, it, expect } from "vitest";
import { OpenClawAdapter } from "./openclaw.js";

const adapter = new OpenClawAdapter();

describe("OpenClawAdapter", () => {
  describe("type and displayName", () => {
    it("has correct type", () => {
      expect(adapter.type).toBe("openclaw");
    });

    it("has correct displayName", () => {
      expect(adapter.displayName).toBe("OpenClaw");
    });
  });

  describe("validateSecrets", () => {
    it("returns valid when ANTHROPIC_API_KEY is present", () => {
      const result = adapter.validateSecrets(["ANTHROPIC_API_KEY"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("returns valid when OPENAI_API_KEY is present", () => {
      const result = adapter.validateSecrets(["OPENAI_API_KEY"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("returns valid when OPENCLAW_API_KEY is present", () => {
      const result = adapter.validateSecrets(["OPENCLAW_API_KEY"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("reports missing when no provider keys are present", () => {
      const result = adapter.validateSecrets([]);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["ANTHROPIC_API_KEY or OPENAI_API_KEY or OPENCLAW_API_KEY"]);
    });

    it("reports missing when only unrelated secrets are present", () => {
      const result = adapter.validateSecrets(["GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["ANTHROPIC_API_KEY or OPENAI_API_KEY or OPENCLAW_API_KEY"]);
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
      expect(config.env.OPTIO_AGENT_TYPE).toBe("openclaw");
      expect(config.env.OPTIO_BRANCH_NAME).toBe("optio/task-test-123");
      expect(config.env.OPTIO_REPO_URL).toBe("https://github.com/org/repo");
      expect(config.env.OPTIO_REPO_BRANCH).toBe("main");
    });

    it("requires provider API key secrets", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.requiredSecrets).toContain("ANTHROPIC_API_KEY");
      expect(config.requiredSecrets).toContain("OPENAI_API_KEY");
      expect(config.requiredSecrets).toContain("OPENCLAW_API_KEY");
    });

    it("sets OPTIO_OPENCLAW_MODEL when openclawModel is provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        openclawModel: "anthropic/claude-sonnet-4",
      });
      expect(config.env.OPTIO_OPENCLAW_MODEL).toBe("anthropic/claude-sonnet-4");
    });

    it("sets OPTIO_OPENCLAW_AGENT when openclawAgent is provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        openclawAgent: "build",
      });
      expect(config.env.OPTIO_OPENCLAW_AGENT).toBe("build");
    });

    it("does not set OPTIO_OPENCLAW_MODEL or OPTIO_OPENCLAW_AGENT when not provided", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_OPENCLAW_MODEL).toBeUndefined();
      expect(config.env.OPTIO_OPENCLAW_AGENT).toBeUndefined();
    });

    it("includes openclaw config as setup file", () => {
      const config = adapter.buildContainerConfig(baseInput);
      const configFile = config.setupFiles?.find((f) => f.path.includes(".openclaw/config.json"));
      expect(configFile).toBeDefined();
      expect(JSON.parse(configFile!.content)).toEqual({
        $schema: "https://openclaw.dev/config.json",
      });
    });

    it("includes task file in setup files when provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        taskFileContent: "# Task\nDo something",
        taskFilePath: ".optio/task.md",
      });
      const taskFile = config.setupFiles?.find((f) => f.path === ".optio/task.md");
      expect(taskFile).toBeDefined();
      expect(taskFile!.content).toBe("# Task\nDo something");
    });

    it("returns only openclaw config in setupFiles when no task file", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.setupFiles).toHaveLength(1);
      expect(config.setupFiles![0].path).toContain("config.json");
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

    it("extracts GitHub PR URL from logs", () => {
      const logs = `Working on task...\nhttps://github.com/org/repo/pull/42\nDone!`;
      const result = adapter.parseResult(0, logs);
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
    });

    it("extracts GitLab MR URL from logs", () => {
      const logs = `Working on task...\nhttps://gitlab.com/org/repo/-/merge_requests/7\nDone!`;
      const result = adapter.parseResult(0, logs);
      expect(result.prUrl).toBe("https://gitlab.com/org/repo/-/merge_requests/7");
    });

    it("extracts summary from last assistant message", () => {
      const logs = [
        '{"type":"message","role":"assistant","content":"Starting work"}',
        '{"type":"message","role":"assistant","content":"All done, PR created"}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.summary).toBe("All done, PR created");
    });

    it("extracts summary from result event", () => {
      const logs = '{"type":"result","result":"Task completed successfully"}';
      const result = adapter.parseResult(0, logs);
      expect(result.summary).toBe("Task completed successfully");
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

    it("leaves cost undefined when not provided", () => {
      const logs = '{"type":"message","role":"assistant","content":"Done"}';
      const result = adapter.parseResult(0, logs);
      expect(result.costUsd).toBeUndefined();
    });

    it("detects error events in JSON output", () => {
      const logs = '{"type":"error","message":"Provider API key is invalid"}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Provider API key is invalid");
    });

    it("detects error envelope in JSON output", () => {
      const logs =
        '{"error":{"message":"Invalid API key","type":"auth_error","code":"invalid_key"}}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid API key");
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
        '{"model":"anthropic/claude-sonnet-4","type":"message","role":"assistant","content":"Hi"}';
      const result = adapter.parseResult(0, logs);
      expect(result.model).toBe("anthropic/claude-sonnet-4");
    });

    it("detects auth errors in raw text", () => {
      const logs = "Error: OPENCLAW_API_KEY authentication failed";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("OPENCLAW_API_KEY");
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

    it("does not compute cost from tokens (provider-agnostic)", () => {
      const logs =
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":1000,"output_tokens":500}}';
      const result = adapter.parseResult(0, logs);
      // OpenClaw is provider-agnostic — no per-token cost calculation
      expect(result.costUsd).toBeUndefined();
    });
  });
});
