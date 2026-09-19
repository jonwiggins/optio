import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseOpenCodeEvent } from "./opencode-event-parser.js";

const TASK_ID = "test-task-oc-123";

// Load the NDJSON fixture
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "__fixtures__", "opencode.ndjson");
const fixtureLines = readFileSync(fixturePath, "utf-8").split("\n").filter(Boolean);

describe("parseOpenCodeEvent", () => {
  it("parses system init event with model and version", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "oc-sess-abc",
      model: "anthropic/claude-sonnet-4",
      version: "0.4.2",
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("system");
    expect(result.entries[0].content).toContain("anthropic/claude-sonnet-4");
    expect(result.entries[0].content).toContain("OpenCode v0.4.2");
    expect(result.sessionId).toBe("oc-sess-abc");
  });

  it("parses system message", () => {
    const line = JSON.stringify({
      type: "message",
      role: "system",
      content: "You are a coding assistant.",
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("system");
    expect(result.entries[0].content).toBe("You are a coding assistant.");
  });

  it("parses assistant text message", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "I will fix this bug.",
      session_id: "oc-sess-1",
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("text");
    expect(result.entries[0].content).toBe("I will fix this bug.");
    expect(result.sessionId).toBe("oc-sess-1");
  });

  it("parses assistant message with array content", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "Part 1" },
        { type: "output_text", text: "Part 2" },
      ],
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("text");
    expect(result.entries[0].content).toBe("Part 1\nPart 2");
  });

  it("parses tool_call event (shell)", () => {
    const line = JSON.stringify({
      type: "tool_call",
      name: "shell",
      call_id: "tc-001",
      arguments: JSON.stringify({ command: "git status" }),
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("tool_use");
    expect(result.entries[0].content).toBe("$ git status");
    expect(result.entries[0].metadata?.toolName).toBe("shell");
    expect(result.entries[0].metadata?.toolUseId).toBe("tc-001");
  });

  it("parses function_call event (read_file)", () => {
    const line = JSON.stringify({
      type: "function_call",
      name: "read_file",
      arguments: { path: "/src/main.ts" },
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries[0].content).toBe("Read /src/main.ts");
  });

  it("parses tool_call event (edit_file)", () => {
    const line = JSON.stringify({
      type: "tool_call",
      name: "edit_file",
      call_id: "tc-002",
      arguments: JSON.stringify({ path: "src/auth/login.ts" }),
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries[0].content).toBe("Edit src/auth/login.ts");
  });

  it("parses tool_result event", () => {
    const line = JSON.stringify({
      type: "tool_result",
      call_id: "tc-001",
      output: "On branch main\nnothing to commit",
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("tool_result");
    expect(result.entries[0].content).toContain("On branch main");
  });

  it("parses function_call_output event", () => {
    const line = JSON.stringify({
      type: "function_call_output",
      call_id: "tc-002",
      output: "File edited successfully",
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("tool_result");
  });

  it("truncates long tool result output", () => {
    const longOutput = "x".repeat(500);
    const line = JSON.stringify({
      type: "tool_result",
      call_id: "tc-001",
      output: longOutput,
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries[0].content.length).toBeLessThan(400);
    expect(result.entries[0].content).toContain("\u2026");
  });

  it("parses error event", () => {
    const line = JSON.stringify({
      type: "error",
      message: "API key is invalid",
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("error");
    expect(result.entries[0].content).toBe("API key is invalid");
  });

  it("parses result event", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Task completed successfully",
      total_cost_usd: 0.0231,
      session_id: "oc-sess-abc",
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    const textEntry = result.entries.find((e) => e.type === "text");
    expect(textEntry?.content).toBe("Task completed successfully");
    const costEntry = result.entries.find((e) => e.type === "info");
    expect(costEntry?.content).toContain("$0.0231");
    expect(result.sessionId).toBe("oc-sess-abc");
  });

  it("parses reasoning event as thinking", () => {
    const line = JSON.stringify({
      type: "reasoning",
      content: "Let me analyze this code...",
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("thinking");
    expect(result.entries[0].content).toBe("Let me analyze this code...");
  });

  it("extracts session_id from events", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Hello",
      session_id: "oc-sess-xyz",
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.sessionId).toBe("oc-sess-xyz");
  });

  it("handles non-JSON lines as raw text", () => {
    const result = parseOpenCodeEvent("[optio] Running OpenCode...", TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("text");
    expect(result.entries[0].content).toBe("[optio] Running OpenCode...");
  });

  it("strips terminal control sequences", () => {
    const result = parseOpenCodeEvent("\x1b[32mgreen text\x1b[0m\r", TASK_ID);
    expect(result.entries[0].content).toBe("green text");
  });

  it("skips empty lines", () => {
    expect(parseOpenCodeEvent("", TASK_ID).entries).toHaveLength(0);
    expect(parseOpenCodeEvent("   ", TASK_ID).entries).toHaveLength(0);
  });

  it("parses usage data in message event", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Done",
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    const infoEntry = result.entries.find((e) => e.type === "info");
    expect(infoEntry).toBeDefined();
    expect(infoEntry?.content).toContain("1000 input tokens");
    expect(infoEntry?.metadata?.inputTokens).toBe(1000);
  });

  it("parses standalone usage event", () => {
    const line = JSON.stringify({
      usage: { prompt_tokens: 2000, completion_tokens: 1000 },
      total_cost_usd: 0.05,
    });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("info");
    expect(result.entries[0].content).toContain("$0.0500");
  });

  it("skips unknown JSON events", () => {
    const line = JSON.stringify({ type: "stream_delta", data: "partial" });
    const result = parseOpenCodeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(0);
  });

  describe("NDJSON fixture", () => {
    it("parses all fixture lines without throwing", () => {
      for (const line of fixtureLines) {
        expect(() => parseOpenCodeEvent(line, TASK_ID)).not.toThrow();
      }
    });

    it("extracts session ID from fixture", () => {
      const allSessionIds = fixtureLines
        .map((line) => parseOpenCodeEvent(line, TASK_ID).sessionId)
        .filter(Boolean);
      expect(allSessionIds.length).toBeGreaterThan(0);
      expect(allSessionIds[0]).toBe("oc-sess-abc123");
    });

    it("extracts system init from fixture", () => {
      const initResult = parseOpenCodeEvent(fixtureLines[0], TASK_ID);
      expect(initResult.entries[0].type).toBe("system");
      expect(initResult.entries[0].content).toContain("anthropic/claude-sonnet-4");
    });

    it("extracts tool calls from fixture", () => {
      const toolCallLines = fixtureLines
        .map((line) => parseOpenCodeEvent(line, TASK_ID))
        .filter((r) => r.entries.some((e) => e.type === "tool_use"));
      expect(toolCallLines.length).toBeGreaterThan(0);
    });

    it("extracts result with cost from fixture", () => {
      const lastLine = fixtureLines[fixtureLines.length - 1];
      const result = parseOpenCodeEvent(lastLine, TASK_ID);
      const costEntry = result.entries.find((e) => e.type === "info" && e.metadata?.cost);
      expect(costEntry).toBeDefined();
      expect(costEntry?.metadata?.cost).toBe(0.0231);
    });
  });

  describe("opencode 1.14.20 run --format json events (real captured shapes)", () => {
    // Shapes captured verbatim from opencode 1.14.20 run --format json in a repo pod.
    const sessionId = "ses_f75374e09ffepLY1K38ctZscdd";

    it("captures sessionId from the camelCase sessionID field on step_start", () => {
      const line = JSON.stringify({
        type: "step_start",
        timestamp: 1789035522262,
        sessionID: sessionId,
        part: { id: "prt_1", messageID: "msg_1", sessionID: sessionId, type: "step-start" },
      });
      const result = parseOpenCodeEvent(line, TASK_ID);
      expect(result.sessionId).toBe(sessionId);
    });

    it("parses a text event (part.text) into a text entry", () => {
      const line = JSON.stringify({
        type: "text",
        timestamp: 1789035522709,
        sessionID: sessionId,
        part: {
          id: "prt_2",
          messageID: "msg_1",
          sessionID: sessionId,
          type: "text",
          text: "PR created: https://github.com/ulbi/helm-iot/pull/771",
        },
      });
      const result = parseOpenCodeEvent(line, TASK_ID);
      const textEntry = result.entries.find((e) => e.type === "text");
      expect(textEntry).toBeDefined();
      expect(textEntry?.content).toContain("PR created");
      expect(result.sessionId).toBe(sessionId);
    });

    it("parses a step_finish event with tokens and cost into an info entry", () => {
      const line = JSON.stringify({
        type: "step_finish",
        timestamp: 1789035522720,
        sessionID: sessionId,
        part: {
          id: "prt_3",
          type: "step-finish",
          reason: "stop",
          tokens: {
            total: 14866,
            input: 14856,
            output: 10,
            reasoning: 0,
            cache: { write: 0, read: 0 },
          },
          cost: 0,
        },
      });
      const result = parseOpenCodeEvent(line, TASK_ID);
      const infoEntry = result.entries.find((e) => e.type === "info");
      expect(infoEntry).toBeDefined();
      expect(infoEntry?.metadata?.inputTokens).toBe(14856);
      expect(infoEntry?.metadata?.outputTokens).toBe(10);
      expect(infoEntry?.metadata?.totalTokens).toBe(14866);
      expect(result.sessionId).toBe(sessionId);
    });

    it("parses a reasoning event into a thinking entry", () => {
      const line = JSON.stringify({
        type: "reasoning",
        sessionID: sessionId,
        part: { type: "reasoning", text: "Plan: read the repo layout first" },
      });
      const result = parseOpenCodeEvent(line, TASK_ID);
      const thinkEntry = result.entries.find((e) => e.type === "thinking");
      expect(thinkEntry).toBeDefined();
      expect(thinkEntry?.content).toContain("repo layout");
      expect(result.sessionId).toBe(sessionId);
    });

    it("parses a tool event (part.tool with state.input) into a tool_use entry", () => {
      const line = JSON.stringify({
        type: "tool",
        sessionID: sessionId,
        part: {
          type: "tool",
          tool: "bash",
          state: { status: "pending", input: { command: "git add README.md" } },
        },
      });
      const result = parseOpenCodeEvent(line, TASK_ID);
      const toolEntry = result.entries.find((e) => e.type === "tool_use");
      expect(toolEntry).toBeDefined();
      expect(toolEntry?.metadata?.toolName).toBe("bash");
      expect(result.sessionId).toBe(sessionId);
    });
  });
});
