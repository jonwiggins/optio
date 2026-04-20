import { describe, it, expect } from "vitest";
import { GeminiAdapter } from "./gemini.js";

const adapter = new GeminiAdapter();

describe("GeminiAdapter", () => {
  describe("type and displayName", () => {
    it("has correct type", () => {
      expect(adapter.type).toBe("gemini");
    });

    it("has correct displayName", () => {
      expect(adapter.displayName).toBe("Google Gemini");
    });
  });

  describe("validateSecrets", () => {
    it("returns valid when GEMINI_API_KEY is present", () => {
      const result = adapter.validateSecrets(["GEMINI_API_KEY"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("accepts GOOGLE_API_KEY as a fallback", () => {
      const result = adapter.validateSecrets(["GOOGLE_API_KEY"]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("reports missing GEMINI_API_KEY", () => {
      const result = adapter.validateSecrets([]);
      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(["GEMINI_API_KEY"]);
    });

    it("does not require GEMINI_API_KEY in vertex-ai mode", () => {
      const result = adapter.validateSecrets([], "vertex-ai");
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("requires GEMINI_API_KEY in api-key mode", () => {
      const result = adapter.validateSecrets([], "api-key");
      expect(result.valid).toBe(false);
      expect(result.missing).toContain("GEMINI_API_KEY");
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
      // Should have task file + gemini settings file
      expect(config.setupFiles!.length).toBeGreaterThanOrEqual(2);
      const taskFile = config.setupFiles!.find((f) => f.path === ".optio/task.md");
      expect(taskFile).toBeDefined();
      expect(taskFile!.content).toBe("# Task\nDo something");
    });

    it("always includes gemini settings file", () => {
      const config = adapter.buildContainerConfig(baseInput);
      const settingsFile = config.setupFiles!.find((f) => f.path.includes(".gemini/settings.json"));
      expect(settingsFile).toBeDefined();
      const settings = JSON.parse(settingsFile!.content);
      expect(settings.security.auth.selectedType).toBe("gemini-api-key");
      expect(settings.general.defaultApprovalMode).toBe("yolo");
      expect(settings.telemetry.enabled).toBe(false);
    });

    it("sets correct env vars", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_TASK_ID).toBe("test-123");
      expect(config.env.OPTIO_AGENT_TYPE).toBe("gemini");
      expect(config.env.OPTIO_BRANCH_NAME).toBe("optio/task-test-123");
    });

    it("requires correct secrets in api-key mode", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.requiredSecrets).toEqual(["GEMINI_API_KEY"]);
    });

    it("does not require GEMINI_API_KEY in vertex-ai mode", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        geminiAuthMode: "vertex-ai",
        googleCloudProject: "my-project",
        googleCloudLocation: "us-central1",
      });
      expect(config.requiredSecrets).toEqual([]);
      expect(config.requiredSecrets).not.toContain("GEMINI_API_KEY");
    });

    it("sets OPTIO_GEMINI_AUTH_MODE and Vertex AI env vars", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        geminiAuthMode: "vertex-ai",
        googleCloudProject: "my-project",
        googleCloudLocation: "us-central1",
      });
      expect(config.env.OPTIO_GEMINI_AUTH_MODE).toBe("vertex-ai");
      expect(config.env.GOOGLE_GENAI_USE_VERTEXAI).toBe("true");
      expect(config.env.GOOGLE_CLOUD_PROJECT).toBe("my-project");
      expect(config.env.GOOGLE_CLOUD_LOCATION).toBe("us-central1");
    });

    it("sets OPTIO_GEMINI_AUTH_MODE to api-key by default", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_GEMINI_AUTH_MODE).toBe("api-key");
    });

    it("sets OPTIO_GEMINI_MODEL when geminiModel is provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        geminiModel: "gemini-2.5-flash",
      });
      expect(config.env.OPTIO_GEMINI_MODEL).toBe("gemini-2.5-flash");
    });

    it("sets vertex-ai auth type in settings file for vertex-ai mode", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        geminiAuthMode: "vertex-ai",
      });
      const settingsFile = config.setupFiles!.find((f) => f.path.includes(".gemini/settings.json"));
      const settings = JSON.parse(settingsFile!.content);
      expect(settings.security.auth.selectedType).toBe("vertex-ai");
    });

    it("uses maxTurnsCoding for maxSessionTurns in settings", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        maxTurnsCoding: 100,
      });
      const settingsFile = config.setupFiles!.find((f) => f.path.includes(".gemini/settings.json"));
      const settings = JSON.parse(settingsFile!.content);
      expect(settings.model.maxSessionTurns).toBe(100);
    });

    it("includes additional context in fallback prompt", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        additionalContext: "The bug is in the auth module",
      });
      expect(config.env.OPTIO_PROMPT).toContain("The bug is in the auth module");
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

    it("extracts GitLab MR URL from logs", () => {
      const logs = `Working...\nhttps://gitlab.com/org/repo/-/merge_requests/17\nDone!`;
      const result = adapter.parseResult(0, logs);
      expect(result.prUrl).toBe("https://gitlab.com/org/repo/-/merge_requests/17");
    });

    it("extracts cost from result event with per-model stats", () => {
      const logs = [
        '{"type":"init","session_id":"sess-1","model":"gemini-2.5-pro"}',
        '{"type":"result","stats":{"gemini-2.5-pro":{"input_tokens":1000000,"output_tokens":100000}}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      // gemini-2.5-pro: 1M input * $1.25/M + 100K output * $10.0/M = $1.25 + $1.0 = $2.25
      expect(result.costUsd).toBeCloseTo(2.25, 1);
      expect(result.inputTokens).toBe(1000000);
      expect(result.outputTokens).toBe(100000);
    });

    it("extracts model from init event", () => {
      const logs = [
        '{"type":"init","session_id":"sess-1","model":"gemini-2.5-flash"}',
        '{"type":"message","role":"assistant","content":"Done"}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.model).toBe("gemini-2.5-flash");
    });

    it("uses model-specific pricing", () => {
      const logs = [
        '{"type":"init","model":"gemini-2.5-flash"}',
        '{"type":"result","stats":{"gemini-2.5-flash":{"input_tokens":1000000,"output_tokens":100000}}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      // gemini-2.5-flash: 1M input * $0.15/M + 100K output * $0.6/M = $0.15 + $0.06 = $0.21
      expect(result.costUsd).toBeCloseTo(0.21, 2);
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
      const logs = "Error: GEMINI_API_KEY is not set";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("GEMINI_API_KEY");
    });

    it("detects vertex AI errors in raw text", () => {
      const logs = "Error: failed to initialize vertex AI ADC";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("vertex");
    });

    it("handles empty logs gracefully", () => {
      const result = adapter.parseResult(0, "");
      expect(result.success).toBe(true);
      expect(result.costUsd).toBeUndefined();
    });

    it("detects model_not_found in raw text", () => {
      const logs = "Error: model_not_found - The model does not exist";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("model_not_found");
    });

    it("detects quota errors in raw text", () => {
      const logs = "Error: quota exceeded for this API key";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("quota");
    });

    it("detects turn limit errors in raw text", () => {
      const logs = "Error: turn limit exceeded, session ended";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("turn limit");
    });

    it("detects server errors in raw text", () => {
      const logs = "Error: 503 service unavailable";
      const result = adapter.parseResult(1, logs);
      expect(result.success).toBe(false);
      expect(result.error).toContain("503");
    });

    it("extracts usage from inline usage objects", () => {
      const logs = [
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":500,"output_tokens":200}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.costUsd).toBeDefined();
      expect(result.costUsd).toBeGreaterThan(0);
      expect(result.inputTokens).toBe(500);
      expect(result.outputTokens).toBe(200);
    });

    it("handles flat stats in result event", () => {
      const logs = '{"type":"result","stats":{"input_tokens":1000,"output_tokens":500}}';
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.costUsd).toBeDefined();
    });

    it("includes cache_read and cache_creation tokens from inline usage in input total", () => {
      const logs =
        '{"type":"message","role":"assistant","content":"Done","usage":{"input_tokens":50,"output_tokens":200,"cache_creation_input_tokens":1000,"cache_read_input_tokens":5000}}';
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(6050);
      expect(result.outputTokens).toBe(200);
    });

    it("includes cache tokens from per-model stats in input total", () => {
      const logs =
        '{"type":"result","stats":{"gemini-2.5-pro":{"input_tokens":50,"output_tokens":200,"cache_creation_input_tokens":1000,"cache_read_input_tokens":5000}}}';
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(6050);
      expect(result.outputTokens).toBe(200);
    });
  });
});
