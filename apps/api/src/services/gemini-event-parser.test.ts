import { describe, it, expect } from "vitest";
import { parseGeminiEvent } from "./gemini-event-parser.js";

const TASK_ID = "test-task-789";

describe("parseGeminiEvent", () => {
  it("parses init event with session ID and model", () => {
    const line = JSON.stringify({
      type: "init",
      session_id: "sess-abc-123",
      model: "gemini-2.5-pro",
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.sessionId).toBe("sess-abc-123");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("system");
    expect(result.entries[0].content).toContain("gemini-2.5-pro");
    expect(result.entries[0].metadata?.model).toBe("gemini-2.5-pro");
  });

  it("parses system message", () => {
    const line = JSON.stringify({
      type: "message",
      role: "system",
      content: "You are a coding assistant.",
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("system");
    expect(result.entries[0].content).toBe("You are a coding assistant.");
  });

  it("parses assistant text message", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "I will fix this bug.",
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("text");
    expect(result.entries[0].content).toBe("I will fix this bug.");
  });

  it("parses assistant message with array content", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
      ],
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("text");
    expect(result.entries[0].content).toBe("Part 1\nPart 2");
  });

  it("parses tool_use event", () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "shell",
      call_id: "call-1",
      arguments: JSON.stringify({ command: "git status" }),
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("tool_use");
    expect(result.entries[0].content).toBe("$ git status");
    expect(result.entries[0].metadata?.toolName).toBe("shell");
    expect(result.entries[0].metadata?.toolUseId).toBe("call-1");
  });

  it("parses tool_use with read_file", () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "read_file",
      arguments: { path: "/src/main.ts" },
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries[0].content).toBe("Read /src/main.ts");
  });

  it("parses tool_use with write_file", () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "write_file",
      arguments: { path: "/src/new.ts" },
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries[0].content).toBe("Write /src/new.ts");
  });

  it("parses tool_use with edit_file", () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "replace_in_file",
      arguments: { path: "/src/main.ts" },
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries[0].content).toBe("Edit /src/main.ts");
  });

  it("parses tool_result event", () => {
    const line = JSON.stringify({
      type: "tool_result",
      call_id: "call-1",
      output: "On branch main\nnothing to commit",
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("tool_result");
    expect(result.entries[0].content).toContain("On branch main");
  });

  it("truncates long tool_result output", () => {
    const longOutput = "x".repeat(500);
    const line = JSON.stringify({
      type: "tool_result",
      call_id: "call-1",
      output: longOutput,
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries[0].content.length).toBeLessThan(400);
    expect(result.entries[0].content).toContain("\u2026");
  });

  it("parses error event", () => {
    const line = JSON.stringify({
      type: "error",
      message: "API key is invalid",
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("error");
    expect(result.entries[0].content).toBe("API key is invalid");
  });

  it("parses result event with per-model stats", () => {
    const line = JSON.stringify({
      type: "result",
      stats: {
        "gemini-2.5-pro": { input_tokens: 5000, output_tokens: 2000 },
      },
      turn_count: 10,
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("info");
    expect(result.entries[0].content).toContain("5000 input tokens");
    expect(result.entries[0].content).toContain("2000 output tokens");
    expect(result.entries[0].content).toContain("10 turns");
    expect(result.entries[0].metadata?.inputTokens).toBe(5000);
    expect(result.entries[0].metadata?.outputTokens).toBe(2000);
  });

  it("handles non-JSON lines as raw text", () => {
    const result = parseGeminiEvent("[optio] Running Google Gemini...", TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("system");
    expect(result.entries[0].content).toBe("[optio] Running Google Gemini...");
  });

  it("strips terminal control sequences", () => {
    const result = parseGeminiEvent("\x1b[32mgreen text\x1b[0m\r", TASK_ID);
    expect(result.entries[0].content).toBe("green text");
  });

  it("skips empty lines", () => {
    expect(parseGeminiEvent("", TASK_ID).entries).toHaveLength(0);
    expect(parseGeminiEvent("   ", TASK_ID).entries).toHaveLength(0);
  });

  it("skips unknown JSON events", () => {
    const line = JSON.stringify({ type: "stream_delta", data: "partial" });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(0);
  });

  it("extracts session ID from id field as fallback", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Hello",
      id: "session-xyz",
    });
    const result = parseGeminiEvent(line, TASK_ID);
    expect(result.sessionId).toBe("session-xyz");
  });
});
