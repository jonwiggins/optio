import { describe, it, expect } from "vitest";
import { parseClaudeEvent } from "./agent-event-parser.js";

const TASK_ID = "test-task-123";

describe("parseClaudeEvent", () => {
  it("parses system init event", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-4-6",
      tools: ["Bash", "Read", "Write"],
      session_id: "session-abc",
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.sessionId).toBe("session-abc");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("system");
    expect(result.entries[0].content).toContain("claude-sonnet-4-6");
    expect(result.entries[0].content).toContain("3 tools");
  });

  it("parses assistant text message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello, I will help you." }],
      },
      session_id: "session-abc",
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("text");
    expect(result.entries[0].content).toBe("Hello, I will help you.");
  });

  it("parses assistant thinking", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "Let me analyze this..." }],
      },
      session_id: "session-abc",
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("thinking");
    expect(result.entries[0].content).toBe("Let me analyze this...");
  });

  it("parses tool use with formatted output", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "git status" },
          },
        ],
      },
      session_id: "session-abc",
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("tool_use");
    expect(result.entries[0].content).toBe("$ git status");
    expect(result.entries[0].metadata?.toolName).toBe("Bash");
  });

  it("formats Read tool use", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/src/main.ts" },
          },
        ],
      },
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries[0].content).toBe("Read /src/main.ts");
  });

  it("formats Edit tool use", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/src/main.ts" },
          },
        ],
      },
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries[0].content).toBe("Edit /src/main.ts");
  });

  it("parses user tool result", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "On branch main\nnothing to commit",
          },
        ],
      },
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("tool_result");
    expect(result.entries[0].content).toContain("On branch main");
  });

  it("truncates long tool results", () => {
    const longContent = "x".repeat(500);
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", content: longContent }],
      },
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries[0].content.length).toBeLessThan(400);
    expect(result.entries[0].content).toContain("\u2026");
  });

  it("parses result event with cost and flags it as terminal", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Task completed successfully",
      total_cost_usd: 0.0534,
      num_turns: 5,
      duration_ms: 12345,
      session_id: "session-abc",
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("info");
    // The result event must NOT echo the assistant's final text: the same
    // text was already streamed via an `assistant` text block, so including
    // it here would render the agent's final line twice in the chat view
    // (once plain, once green-tinted from the info-type highlight).
    expect(result.entries[0].content).not.toContain("Task completed successfully");
    expect(result.entries[0].content).toContain("$0.0534");
    expect(result.entries[0].content).toContain("5 turns");
    expect(result.entries[0].metadata?.cost).toBe(0.0534);
    // The task worker closes stdin on terminal events so claude exits
    // instead of idling in stream-json input mode.
    expect(result.isTerminal).toBe(true);
  });

  it("emits result-event metadata even when there is no result text", () => {
    const line = JSON.stringify({
      type: "result",
      total_cost_usd: 0.001,
      num_turns: 1,
      duration_ms: 500,
      session_id: "session-abc",
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("info");
    expect(result.entries[0].content).toContain("1 turns");
    expect(result.entries[0].content).toContain("$0.0010");
    expect(result.isTerminal).toBe(true);
  });

  it("does not flag non-result events as terminal", () => {
    const system = parseClaudeEvent(
      JSON.stringify({
        type: "system",
        subtype: "init",
        model: "claude-sonnet-4-6",
        tools: ["Bash"],
        session_id: "session-abc",
      }),
      TASK_ID,
    );
    expect(system.isTerminal).toBeUndefined();

    const assistant = parseClaudeEvent(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
        session_id: "session-abc",
      }),
      TASK_ID,
    );
    expect(assistant.isTerminal).toBeUndefined();
  });

  it("skips rate limit events", () => {
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: {} });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(0);
  });

  it("handles non-JSON lines as raw text", () => {
    const result = parseClaudeEvent("[optio] Starting agent...", TASK_ID);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].type).toBe("text");
    expect(result.entries[0].content).toBe("[optio] Starting agent...");
  });

  it("strips terminal control sequences", () => {
    const result = parseClaudeEvent("\x1b[32mgreen text\x1b[0m\r", TASK_ID);
    expect(result.entries[0].content).toBe("green text");
  });

  it("skips empty lines", () => {
    expect(parseClaudeEvent("", TASK_ID).entries).toHaveLength(0);
    expect(parseClaudeEvent("   ", TASK_ID).entries).toHaveLength(0);
  });

  it("handles multiple content blocks in one message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Analyzing..." },
          { type: "tool_use", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    });
    const result = parseClaudeEvent(line, TASK_ID);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].type).toBe("thinking");
    expect(result.entries[1].type).toBe("tool_use");
  });
});
