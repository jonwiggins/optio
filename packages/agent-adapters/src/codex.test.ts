import { describe, it, expect } from "vitest";
import { CodexAdapter } from "./codex.js";

const adapter = new CodexAdapter();

describe("CodexAdapter", () => {
  describe("type and displayName", () => {
    it("has correct type", () => {
      expect(adapter.type).toBe("codex");
    });

    it("has correct displayName", () => {
      expect(adapter.displayName).toBe("OpenAI Codex");
    });
  });

  describe("validateSecrets", () => {
    it("returns valid when OPENAI_API_KEY is present", () => {
      const result = adapter.validateSecrets(["OPENAI_API_KEY"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("reports missing OPENAI_API_KEY", () => {
      const result = adapter.validateSecrets([]);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["OPENAI_API_KEY"]);
    });

    it("does not require OPENAI_API_KEY in app-server mode", () => {
      const result = adapter.validateSecrets([], "app-server");
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("requires OPENAI_API_KEY in api-key mode", () => {
      const result = adapter.validateSecrets([], "api-key");
      expect(result.valid).toBe(false);
      expect(result.missing).toContain("OPENAI_API_KEY");
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

    it("falls back to built prompt when no rendered prompt", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_PROMPT).toContain("Fix the bug");
      expect(config.env.OPTIO_PROMPT).toContain("Instructions:");
    });

    it("includes task file path in fallback prompt", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        taskFilePath: ".optio/task.md",
        taskFileContent: "# Task details",
      });
      expect(config.env.OPTIO_PROMPT).toContain(".optio/task.md");
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

    it("sets correct env vars", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_TASK_ID).toBe("test-123");
      expect(config.env.OPTIO_AGENT_TYPE).toBe("codex");
      expect(config.env.OPTIO_BRANCH_NAME).toBe("optio/task-test-123");
    });

    it("requires correct secrets in api-key mode", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.requiredSecrets).toEqual(["OPENAI_API_KEY"]);
    });

    it("does not require OPENAI_API_KEY in app-server mode", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        codexAuthMode: "app-server",
        codexAppServerUrl: "ws://localhost:3900/v1/connect",
      });
      expect(config.requiredSecrets).toEqual([]);
      expect(config.requiredSecrets).not.toContain("OPENAI_API_KEY");
    });

    it("sets OPTIO_CODEX_AUTH_MODE and OPTIO_CODEX_APP_SERVER_URL in app-server mode", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        codexAuthMode: "app-server",
        codexAppServerUrl: "ws://localhost:3900/v1/connect",
      });
      expect(config.env.OPTIO_CODEX_AUTH_MODE).toBe("app-server");
      expect(config.env.OPTIO_CODEX_APP_SERVER_URL).toBe("ws://localhost:3900/v1/connect");
    });

    it("sets OPTIO_CODEX_AUTH_MODE to api-key by default", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_CODEX_AUTH_MODE).toBe("api-key");
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

    it("extracts cost from usage data in JSON events", () => {
      const logs = [
        '{"type":"message","role":"assistant","content":"Working on it"}',
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":1000,"output_tokens":500}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.costUsd).toBeDefined();
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it("extracts cost from OpenAI-style token naming", () => {
      const logs = [
        '{"type":"message","role":"assistant","content":"Done","usage":{"prompt_tokens":2000,"completion_tokens":1000}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.costUsd).toBeDefined();
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it("uses total_cost_usd when provided directly", () => {
      const logs = '{"type":"result","total_cost_usd":0.0534}';
      const result = adapter.parseResult(0, logs);
      expect(result.costUsd).toBe(0.0534);
    });

    it("detects error events in JSON output", () => {
      const logs = '{"type":"error","message":"API key is invalid"}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("API key is invalid");
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

    it("detects auth errors in raw text", () => {
      const logs = "Error: OPENAI_API_KEY is not set";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("OPENAI_API_KEY");
    });

    it("handles empty logs gracefully", () => {
      const result = adapter.parseResult(0, "");
      expect(result.success).toBe(true);
      expect(result.costUsd).toBeUndefined();
    });

    it("handles model-specific pricing", () => {
      const logs = [
        '{"model":"o4-mini","type":"message","role":"assistant","content":"Hi"}',
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":1000000,"output_tokens":100000}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      // o4-mini: 1M input tokens * $1.1/M + 100K output tokens * $4.4/M = $1.1 + $0.44 = $1.54
      expect(result.costUsd).toBeCloseTo(1.54, 1);
    });

    it("detects OpenAI structured API error envelope", () => {
      const logs =
        '{"error":{"message":"The model `gpt-5` does not exist","type":"invalid_request_error","code":"model_not_found"}}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("The model `gpt-5` does not exist");
    });

    it("includes cache_read and cache_creation tokens in input total", () => {
      const logs =
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":50,"output_tokens":200,"cache_creation_input_tokens":1000,"cache_read_input_tokens":5000}}';
      const result = adapter.parseResult(0, logs);
      expect(result.costUsd).toBeDefined();
    });

    it("accounts for cached tokens in cost calculation", () => {
      const logs = [
        '{"model":"o4-mini","type":"message","role":"assistant","content":"Hi"}',
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":1000000,"output_tokens":100000,"cached_tokens":500000}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      // o4-mini: 500K non-cached * $1.1/M + 500K cached * $0.275/M + 100K output * $4.4/M
      // = $0.55 + $0.1375 + $0.44 = $1.1275
      expect(result.costUsd).toBeCloseTo(1.1275, 2);
    });

    it("accounts for cached tokens via prompt_tokens_details", () => {
      const logs = [
        '{"model":"gpt-4.1","type":"message","role":"assistant","content":"Done","usage":{"prompt_tokens":100000,"completion_tokens":10000,"prompt_tokens_details":{"cached_tokens":60000}}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      // gpt-4.1: 40K non-cached * $2.0/M + 60K cached * $0.5/M + 10K output * $8.0/M
      // = $0.08 + $0.03 + $0.08 = $0.19
      expect(result.costUsd).toBeCloseTo(0.19, 2);
    });

    it("detects model_not_found in raw text", () => {
      const logs = "Error: model_not_found - The model does not exist";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("model_not_found");
    });

    it("detects context length exceeded in raw text", () => {
      const logs = "Error: This model's maximum context length is 128000 tokens";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("context length");
    });

    it("detects content filter errors in raw text", () => {
      const logs = "Error: content_filter - Output was blocked by content policy";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("content_filter");
    });

    it("detects server errors in raw text", () => {
      const logs = "Error: 503 service unavailable";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("503");
    });
  });
});
