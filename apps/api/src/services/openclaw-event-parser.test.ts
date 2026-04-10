import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseOpenClawEvent } from "./openclaw-event-parser.js";

const TASK_ID = "test-task-claw-123";

// Load the NDJSON fixture
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "__fixtures__", "openclaw.ndjson");
const fixtureLines = readFileSync(fixturePath, "utf-8").split("\n").filter(Boolean);

describe("parseOpenClawEvent", () => {
  it("parses system init event with model and version", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claw-sess-abc",
      model: "anthropic/claude-sonnet-4",
      version: "1.2.0",
    });
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("system");
    expect(result.entries[0].content).toContain("anthropic/claude-sonnet-4");
    expect(result.entries[0].content).toContain("OpenClaw v1.2.0");
    expect(result.sessionId).toBe("claw-sess-abc");
  });

  it("parses system message", () => {
    const line = JSON.stringify({
      type: "message",
      role: "system",
      content: "You are a coding assistant.",
    });
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("system");
    expect(result.entries[0].content).toBe("You are a coding assistant.");
  });

  it("parses assistant text message", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "I will fix this bug.",
      session_id: "claw-sess-1",
    });
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("text");
    expect(result.entries[0].content).toBe("I will fix this bug.");
    expect(result.sessionId).toBe("claw-sess-1");
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
    const result = parseOpenClawEvent(line, TASK_ID);
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
    const result = parseOpenClawEvent(line, TASK_ID);
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
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries[0].content).toBe("Read /src/main.ts");
  });

  it("parses tool_call event (edit_file)", () => {
    const line = JSON.stringify({
      type: "tool_call",
      name: "edit_file",
      call_id: "tc-002",
      arguments: JSON.stringify({ path: "src/auth/login.ts" }),
    });
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries[0].content).toBe("Edit src/auth/login.ts");
  });

  it("parses tool_result event", () => {
    const line = JSON.stringify({
      type: "tool_result",
      call_id: "tc-001",
      output: "On branch main\nnothing to commit",
    });
    const result = parseOpenClawEvent(line, TASK_ID);
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
    const result = parseOpenClawEvent(line, TASK_ID);
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
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries[0].content.length).toBeLessThan(400);
    expect(result.entries[0].content).toContain("\u2026");
  });

  it("parses error event", () => {
    const line = JSON.stringify({
      type: "error",
      message: "API key is invalid",
    });
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("error");
    expect(result.entries[0].content).toBe("API key is invalid");
  });

  it("parses result event", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Task completed successfully",
      total_cost_usd: 0.0198,
      session_id: "claw-sess-abc",
    });
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    const textEntry = result.entries.find((e) => e.type === "text");
    expect(textEntry?.content).toBe("Task completed successfully");
    const costEntry = result.entries.find((e) => e.type === "info");
    expect(costEntry?.content).toContain("$0.0198");
    expect(result.sessionId).toBe("claw-sess-abc");
  });

  it("parses reasoning event as thinking", () => {
    const line = JSON.stringify({
      type: "reasoning",
      content: "Let me analyze this code...",
    });
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("thinking");
    expect(result.entries[0].content).toBe("Let me analyze this code...");
  });

  it("extracts session_id from events", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Hello",
      session_id: "claw-sess-xyz",
    });
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.sessionId).toBe("claw-sess-xyz");
  });

  it("handles non-JSON lines as raw text", () => {
    const result = parseOpenClawEvent("[optio] Running OpenClaw...", TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("text");
    expect(result.entries[0].content).toBe("[optio] Running OpenClaw...");
  });

  it("strips terminal control sequences", () => {
    const result = parseOpenClawEvent("\x1b[32mgreen text\x1b[0m\r", TASK_ID);
    expect(result.entries[0].content).toBe("green text");
  });

  it("skips empty lines", () => {
    expect(parseOpenClawEvent("", TASK_ID).entries).toHaveLength(0);
    expect(parseOpenClawEvent("   ", TASK_ID).entries).toHaveLength(0);
  });

  it("parses usage data in message event", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Done",
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const result = parseOpenClawEvent(line, TASK_ID);
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
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("info");
    expect(result.entries[0].content).toContain("$0.0500");
  });

  it("skips unknown JSON events", () => {
    const line = JSON.stringify({ type: "stream_delta", data: "partial" });
    const result = parseOpenClawEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(0);
  });

  describe("NDJSON fixture", () => {
    it("parses all fixture lines without throwing", () => {
      for (const line of fixtureLines) {
        expect(() => parseOpenClawEvent(line, TASK_ID)).not.toThrow();
      }
    });

    it("extracts session ID from fixture", () => {
      const allSessionIds = fixtureLines
        .map((line) => parseOpenClawEvent(line, TASK_ID).sessionId)
        .filter(Boolean);
      expect(allSessionIds.length).toBeGreaterThan(0);
      expect(allSessionIds[0]).toBe("oc-sess-claw001");
    });

    it("extracts system init from fixture", () => {
      const initResult = parseOpenClawEvent(fixtureLines[0], TASK_ID);
      expect(initResult.entries[0].type).toBe("system");
      expect(initResult.entries[0].content).toContain("anthropic/claude-sonnet-4");
    });

    it("extracts tool calls from fixture", () => {
      const toolCallLines = fixtureLines
        .map((line) => parseOpenClawEvent(line, TASK_ID))
        .filter((r) => r.entries.some((e) => e.type === "tool_use"));
      expect(toolCallLines.length).toBeGreaterThan(0);
    });

    it("extracts result with cost from fixture", () => {
      const lastLine = fixtureLines[fixtureLines.length - 1];
      const result = parseOpenClawEvent(lastLine, TASK_ID);
      const costEntry = result.entries.find((e) => e.type === "info" && e.metadata?.cost);
      expect(costEntry).toBeDefined();
      expect(costEntry?.metadata?.cost).toBe(0.0198);
    });
  });
});
