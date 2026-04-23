import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code.js";

const adapter = new ClaudeCodeAdapter();

describe("ClaudeCodeAdapter", () => {
  describe("type and displayName", () => {
    it("has correct type", () => {
      expect(adapter.type).toBe("claude-code");
    });

    it("has correct displayName", () => {
      expect(adapter.displayName).toBe("Claude Code");
    });
  });

  describe("validateSecrets", () => {
    it("returns valid with empty secrets", () => {
      const result = adapter.validateSecrets([]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("returns valid regardless of what secrets are passed", () => {
      const result = adapter.validateSecrets([
        "ANTHROPIC_API_KEY",
        "GITHUB_TOKEN",
        "RANDOM_SECRET",
      ]);
      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
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
      expect(config.env.OPTIO_REPO_URL).toBe("https://github.com/org/repo");
      expect(config.env.OPTIO_REPO_BRANCH).toBe("main");
      expect(config.env.OPTIO_PROMPT).toBe("Fix the bug");
      expect(config.env.OPTIO_AGENT_TYPE).toBe("claude-code");
      expect(config.env.OPTIO_BRANCH_NAME).toBe("optio/task-test-123");
      expect(config.env.OPTIO_AUTH_MODE).toBe("api-key");
    });

    it("defaults OPTIO_AUTH_MODE to api-key", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.env.OPTIO_AUTH_MODE).toBe("api-key");
    });

    it("requires ANTHROPIC_API_KEY in api-key mode", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.requiredSecrets).toEqual(["ANTHROPIC_API_KEY"]);
    });

    it("does not require ANTHROPIC_API_KEY in max-subscription mode", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        claudeAuthMode: "max-subscription",
      });
      expect(config.requiredSecrets).toEqual([]);
      expect(config.requiredSecrets).not.toContain("ANTHROPIC_API_KEY");
    });

    it("sets OPTIO_API_URL in max-subscription mode with default fallback", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        claudeAuthMode: "max-subscription",
      });
      expect(config.env.OPTIO_API_URL).toBe("http://host.docker.internal:4000");
    });

    it("sets OPTIO_API_URL from input in max-subscription mode", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        claudeAuthMode: "max-subscription",
        optioApiUrl: "http://optio-api:4000",
      });
      expect(config.env.OPTIO_API_URL).toBe("http://optio-api:4000");
    });

    describe("vertex-ai mode", () => {
      it("does not require ANTHROPIC_API_KEY", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          claudeAuthMode: "vertex-ai",
          googleCloudProject: "my-gcp-project",
          googleCloudLocation: "us-east5",
        });
        expect(config.requiredSecrets).toEqual([]);
        expect(config.requiredSecrets).not.toContain("ANTHROPIC_API_KEY");
      });

      it("sets CLAUDE_CODE_USE_VERTEX=1 to enable Vertex AI routing", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          claudeAuthMode: "vertex-ai",
          googleCloudProject: "my-gcp-project",
          googleCloudLocation: "us-east5",
        });
        expect(config.env.CLAUDE_CODE_USE_VERTEX).toBe("1");
        expect(config.env.ANTHROPIC_VERTEX_PROJECT_ID).toBe("my-gcp-project");
        expect(config.env.CLOUD_ML_REGION).toBe("us-east5");
      });

      it("writes service account key file when provided (for non-GKE environments)", () => {
        const serviceAccountKey = '{"type":"service_account","project_id":"test"}';
        const config = adapter.buildContainerConfig({
          ...baseInput,
          claudeAuthMode: "vertex-ai",
          googleCloudProject: "my-gcp-project",
          googleCloudLocation: "us-east5",
          claudeVertexServiceAccountKey: serviceAccountKey,
        });
        const keyFile = config.setupFiles!.find(
          (f) => f.path === "/home/agent/.config/gcloud/gsa-key.json",
        );
        expect(keyFile).toBeDefined();
        expect(keyFile!.content).toBe(serviceAccountKey);
        expect(keyFile!.sensitive).toBe(true);
        expect(config.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(
          "/home/agent/.config/gcloud/gsa-key.json",
        );
      });

      it("relies on workload identity when no service account key provided (GKE)", () => {
        const config = adapter.buildContainerConfig({
          ...baseInput,
          claudeAuthMode: "vertex-ai",
          googleCloudProject: "my-gcp-project",
          googleCloudLocation: "us-east5",
          // No claudeVertexServiceAccountKey - will use GKE workload identity
        });
        // Should not create key file or set GOOGLE_APPLICATION_CREDENTIALS
        // GKE workload identity provides ADC automatically
        expect(config.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
        const keyFile = config.setupFiles!.find(
          (f) => f.path === "/home/agent/.config/gcloud/gsa-key.json",
        );
        expect(keyFile).toBeUndefined();
      });
    });
    it("generates correct branch name with TASK_BRANCH_PREFIX", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        taskId: "abc-456",
      });
      expect(config.env.OPTIO_BRANCH_NAME).toBe("optio/task-abc-456");
    });

    it("includes task file in setupFiles when taskFileContent and taskFilePath provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        taskFileContent: "# Task\nDo something",
        taskFilePath: ".optio/task.md",
      });
      const taskFile = config.setupFiles!.find((f) => f.path === ".optio/task.md");
      expect(taskFile).toBeDefined();
      expect(taskFile!.content).toBe("# Task\nDo something");
    });

    it("always includes Claude settings file at /home/agent/.claude/settings.json", () => {
      const config = adapter.buildContainerConfig(baseInput);
      const settingsFile = config.setupFiles!.find(
        (f) => f.path === "/home/agent/.claude/settings.json",
      );
      expect(settingsFile).toBeDefined();
      const settings = JSON.parse(settingsFile!.content);
      expect(settings.hasCompletedOnboarding).toBe(true);
    });

    it("sets hasCompletedOnboarding in Claude settings", () => {
      const config = adapter.buildContainerConfig(baseInput);
      const settingsFile = config.setupFiles!.find(
        (f) => f.path === "/home/agent/.claude/settings.json",
      );
      const settings = JSON.parse(settingsFile!.content);
      expect(settings.hasCompletedOnboarding).toBe(true);
    });

    it("sets model with [1m] context window suffix", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        claudeModel: "opus",
        claudeContextWindow: "1m",
      });
      const settingsFile = config.setupFiles!.find(
        (f) => f.path === "/home/agent/.claude/settings.json",
      );
      const settings = JSON.parse(settingsFile!.content);
      expect(settings.model).toBe("opus[1m]");
    });

    it("sets model without suffix when no 1m context", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        claudeModel: "sonnet",
      });
      const settingsFile = config.setupFiles!.find(
        (f) => f.path === "/home/agent/.claude/settings.json",
      );
      const settings = JSON.parse(settingsFile!.content);
      expect(settings.model).toBe("sonnet");
    });

    it("sets alwaysThinkingEnabled when claudeThinking provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        claudeThinking: true,
      });
      const settingsFile = config.setupFiles!.find(
        (f) => f.path === "/home/agent/.claude/settings.json",
      );
      const settings = JSON.parse(settingsFile!.content);
      expect(settings.alwaysThinkingEnabled).toBe(true);
    });

    it("sets effortLevel when claudeEffort provided", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        claudeEffort: "high",
      });
      const settingsFile = config.setupFiles!.find(
        (f) => f.path === "/home/agent/.claude/settings.json",
      );
      const settings = JSON.parse(settingsFile!.content);
      expect(settings.effortLevel).toBe("high");
    });

    it("returns /opt/optio/entrypoint.sh as command", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.command).toEqual(["/opt/optio/entrypoint.sh"]);
    });
  });

  describe("parseResult", () => {
    it("returns success for exit code 0", () => {
      const result = adapter.parseResult(0, "some output\nmore output");
      expect(result.success).toBe(true);
      expect(result.summary).toBe("Agent completed successfully");
      expect(result.error).toBeUndefined();
    });

    it("returns failure for non-zero exit code with error message", () => {
      const result = adapter.parseResult(1, "some output");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Exit code: 1");
      expect(result.summary).toBe("Agent exited with code 1");
    });

    it("extracts PR URL from logs", () => {
      const logs = `Working on task...\nhttps://github.com/org/repo/pull/42\nDone!`;
      const result = adapter.parseResult(0, logs);
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
    });

    it("extracts cost from total_cost_usd", () => {
      const logs = '{"type":"result","total_cost_usd":0.0534}';
      const result = adapter.parseResult(0, logs);
      expect(result.costUsd).toBe(0.0534);
    });

    it("extracts model from system init event", () => {
      const logs = [
        '{"type":"system","subtype":"init","model":"claude-sonnet-4-20250514"}',
        '{"type":"assistant","message":{"content":"Hello","usage":{"input_tokens":100,"output_tokens":50}}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.model).toBe("claude-sonnet-4-20250514");
    });

    it("accumulates input/output tokens from assistant messages", () => {
      const logs = [
        '{"type":"assistant","message":{"usage":{"input_tokens":100,"output_tokens":50}}}',
        '{"type":"assistant","message":{"usage":{"input_tokens":200,"output_tokens":75}}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(125);
    });

    it("includes cache_read and cache_creation tokens in input total", () => {
      const logs = [
        '{"type":"assistant","message":{"usage":{"input_tokens":50,"output_tokens":200,"cache_creation_input_tokens":1000,"cache_read_input_tokens":5000}}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(6050);
      expect(result.outputTokens).toBe(200);
    });

    it("accumulates cache tokens across multiple assistant messages", () => {
      const logs = [
        '{"type":"assistant","message":{"usage":{"input_tokens":50,"output_tokens":100,"cache_creation_input_tokens":1000,"cache_read_input_tokens":0}}}',
        '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":80,"cache_read_input_tokens":1000}}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.inputTokens).toBe(2060);
      expect(result.outputTokens).toBe(180);
    });

    it("extracts error from result event with is_error=true when exitCode is non-zero", () => {
      const logs = '{"type":"result","is_error":true,"result":"API rate limit exceeded"}';
      const result = adapter.parseResult(1, logs);
      expect(result.error).toBe("API rate limit exceeded");
    });

    it("does NOT extract error from is_error result when exitCode is 0", () => {
      const logs = '{"type":"result","is_error":true,"result":"API rate limit exceeded"}';
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("falls back to Exit code: N when no structured error", () => {
      const result = adapter.parseResult(42, "no json here");
      expect(result.error).toBe("Exit code: 42");
    });

    it("handles empty logs", () => {
      const result = adapter.parseResult(0, "");
      expect(result.success).toBe(true);
      expect(result.costUsd).toBeUndefined();
      expect(result.prUrl).toBeUndefined();
      expect(result.inputTokens).toBeUndefined();
      expect(result.outputTokens).toBeUndefined();
      expect(result.model).toBeUndefined();
    });

    it("handles non-JSON lines gracefully", () => {
      const logs = [
        "This is plain text",
        "Another line without JSON",
        '{"type":"assistant","message":{"usage":{"input_tokens":50,"output_tokens":25}}}',
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(true);
      expect(result.inputTokens).toBe(50);
      expect(result.outputTokens).toBe(25);
    });

    it("sets summary to Agent completed successfully on success", () => {
      const result = adapter.parseResult(0, "done");
      expect(result.summary).toBe("Agent completed successfully");
    });

    it("sets summary to Agent exited with code N on failure", () => {
      const result = adapter.parseResult(3, "failed");
      expect(result.summary).toBe("Agent exited with code 3");
    });
  });
});
