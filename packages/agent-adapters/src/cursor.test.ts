import { describe, it, expect } from "vitest";
import { CursorAdapter } from "./cursor.js";
import type { AgentTaskInput } from "@optio/shared";

const adapter = new CursorAdapter();

const baseInput: AgentTaskInput = {
  taskId: "task-123",
  prompt: "Fix the bug",
  repoUrl: "https://github.com/acme/widgets",
  repoBranch: "main",
};

describe("CursorAdapter", () => {
  it("has the right type and display name", () => {
    expect(adapter.type).toBe("cursor");
    expect(adapter.displayName).toBe("Cursor");
  });

  describe("validateSecrets", () => {
    it("requires CURSOR_API_KEY", () => {
      expect(adapter.validateSecrets([])).toEqual({
        valid: false,
        missing: ["CURSOR_API_KEY"],
      });
      expect(adapter.validateSecrets(["ANTHROPIC_API_KEY"])).toEqual({
        valid: false,
        missing: ["CURSOR_API_KEY"],
      });
      expect(adapter.validateSecrets(["CURSOR_API_KEY"])).toEqual({ valid: true, missing: [] });
    });
  });

  describe("buildContainerConfig", () => {
    it("sets the standard OPTIO_* env vars and requires CURSOR_API_KEY", () => {
      const config = adapter.buildContainerConfig(baseInput);
      expect(config.command).toEqual(["/opt/optio/entrypoint.sh"]);
      expect(config.env.OPTIO_TASK_ID).toBe("task-123");
      expect(config.env.OPTIO_AGENT_TYPE).toBe("cursor");
      expect(config.env.OPTIO_PROMPT).toBe("Fix the bug");
      expect(config.env.OPTIO_BRANCH_NAME).toBe("optio/task-task-123");
      expect(config.requiredSecrets).toEqual(["CURSOR_API_KEY"]);
      expect(config.env.OPTIO_CURSOR_MODEL).toBeUndefined();
    });

    it("prefers the rendered prompt", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        renderedPrompt: "Rendered instructions",
      });
      expect(config.env.OPTIO_PROMPT).toBe("Rendered instructions");
    });

    it("passes the model through OPTIO_CURSOR_MODEL", () => {
      const config = adapter.buildContainerConfig({ ...baseInput, cursorModel: "composer-2.5" });
      expect(config.env.OPTIO_CURSOR_MODEL).toBe("composer-2.5");
    });

    it("writes the task file as a setup file", () => {
      const config = adapter.buildContainerConfig({
        ...baseInput,
        taskFileContent: "# Task",
        taskFilePath: "TASK.md",
      });
      expect(config.setupFiles).toEqual([{ path: "TASK.md", content: "# Task" }]);
    });
  });

  describe("parseResult", () => {
    it("reports success with the final result text as summary", () => {
      const logs = [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "sess-1",
          model: "composer-2.5",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Working on it" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          result: "Opened a PR with the fix",
          session_id: "sess-1",
        }),
      ].join("\n");

      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("Opened a PR with the fix");
      expect(result.model).toBe("composer-2.5");
      expect(result.costUsd).toBeUndefined();
    });

    it("extracts GitHub PR URLs", () => {
      const logs = "Opened https://github.com/acme/widgets/pull/42 for review\n";
      const result = adapter.parseResult(0, logs);
      expect(result.prUrl).toBe("https://github.com/acme/widgets/pull/42");
    });

    it("extracts GitLab MR URLs but not API URLs", () => {
      const logs = [
        "https://gitlab.com/api/v4/projects/1/-/merge_requests/9",
        "https://gitlab.com/acme/widgets/-/merge_requests/7",
      ].join("\n");
      const result = adapter.parseResult(0, logs);
      expect(result.prUrl).toBe("https://gitlab.com/acme/widgets/-/merge_requests/7");
    });

    it("fails on a result event with is_error", () => {
      const logs = JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Something broke",
      });
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Something broke");
    });

    it("fails on error events", () => {
      const logs = JSON.stringify({ type: "error", message: "Model unavailable" });
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Model unavailable");
    });

    it("fails on an error envelope", () => {
      const logs = JSON.stringify({ error: { message: "Invalid API key" } });
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid API key");
    });

    it("detects raw-text auth errors from stderr", () => {
      const result = adapter.parseResult(0, "Error: CURSOR_API_KEY is missing or invalid\n");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/CURSOR_API_KEY/);
    });

    it("detects usage-limit errors", () => {
      const result = adapter.parseResult(0, "You have reached your usage limit for this plan\n");
      expect(result.success).toBe(false);
    });

    it("fails on non-zero exit code even without error events", () => {
      const result = adapter.parseResult(2, "");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Exit code: 2");
      expect(result.summary).toBe("Agent exited with code 2");
    });

    it("handles string assistant content", () => {
      const logs = JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Plain string reply" },
      });
      const result = adapter.parseResult(0, logs);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("Plain string reply");
    });

    it("truncates long summaries", () => {
      const logs = JSON.stringify({
        type: "result",
        is_error: false,
        result: "x".repeat(300),
      });
      const result = adapter.parseResult(0, logs);
      expect(result.summary!.length).toBe(201);
      expect(result.summary!.endsWith("…")).toBe(true);
    });

    it("ignores non-JSON informational lines", () => {
      const result = adapter.parseResult(0, "Cloning repository...\nDone.\n");
      expect(result.success).toBe(true);
      expect(result.summary).toBe("Agent completed successfully");
    });
  });
});
