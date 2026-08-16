import { describe, it, expect } from "vitest";
import { parseCursorEvent } from "./cursor-event-parser.js";

const TASK_ID = "task-1";

describe("parseCursorEvent", () => {
  it("parses the init event and extracts the session id", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-abc",
      model: "composer-2.5",
      permissionMode: "default",
    });
    const { entries, sessionId, isTerminal } = parseCursorEvent(line, TASK_ID);
    expect(sessionId).toBe("sess-abc");
    expect(isTerminal).toBeUndefined();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("system");
    expect(entries[0].content).toContain("composer-2.5");
    expect(entries[0].metadata).toEqual({ model: "composer-2.5" });
  });

  it("parses assistant messages with block-array content", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] },
    });
    const { entries } = parseCursorEvent(line, TASK_ID);
    expect(entries).toEqual([expect.objectContaining({ type: "text", content: "Hello there" })]);
  });

  it("parses assistant messages with string content", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "Plain reply" },
    });
    const { entries } = parseCursorEvent(line, TASK_ID);
    expect(entries[0].content).toBe("Plain reply");
  });

  it("skips user (echoed prompt) events", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "the prompt" }] },
    });
    expect(parseCursorEvent(line, TASK_ID).entries).toEqual([]);
  });

  it("parses nested tool_call started events", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "call-1",
      tool_call: { readToolCall: { args: { path: "src/index.ts" } } },
    });
    const { entries } = parseCursorEvent(line, TASK_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("tool_use");
    expect(entries[0].content).toBe("Read src/index.ts");
    expect(entries[0].metadata).toMatchObject({ toolName: "read", toolUseId: "call-1" });
  });

  it("parses tool_call completed events into tool_result entries", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      call_id: "call-1",
      tool_call: { readToolCall: { args: { path: "a.ts" }, result: { success: true } } },
    });
    const { entries } = parseCursorEvent(line, TASK_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("tool_result");
    expect(entries[0].metadata).toEqual({ toolUseId: "call-1" });
  });

  it("truncates long tool outputs", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "completed",
      call_id: "c",
      tool_call: { shellToolCall: { args: { command: "ls" }, result: "y".repeat(500) } },
    });
    const { entries } = parseCursorEvent(line, TASK_ID);
    expect(entries[0].content.length).toBe(301);
  });

  it("formats flat shell tool calls as commands", () => {
    const line = JSON.stringify({
      type: "tool_call",
      subtype: "started",
      call_id: "c2",
      tool_call: { name: "shell", args: { command: "pnpm test\npnpm build" } },
    });
    const { entries } = parseCursorEvent(line, TASK_ID);
    expect(entries[0].content).toBe("$ pnpm test");
  });

  it("parses error events", () => {
    const line = JSON.stringify({ type: "error", message: "boom" });
    const { entries } = parseCursorEvent(line, TASK_ID);
    expect(entries[0]).toMatchObject({ type: "error", content: "boom" });
  });

  it("marks the result event as terminal", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5432,
      result: "All done",
      session_id: "sess-abc",
    });
    const { entries, sessionId, isTerminal } = parseCursorEvent(line, TASK_ID);
    expect(isTerminal).toBe(true);
    expect(sessionId).toBe("sess-abc");
    expect(entries[0].type).toBe("info");
    expect(entries[0].content).toContain("success");
    expect(entries[0].content).toContain("5s");
  });

  it("renders error results as error entries", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "Usage limit reached",
    });
    const { entries, isTerminal } = parseCursorEvent(line, TASK_ID);
    expect(isTerminal).toBe(true);
    expect(entries[0]).toMatchObject({ type: "error", content: "Usage limit reached" });
  });

  it("passes through raw text lines, stripping ANSI codes", () => {
    const { entries } = parseCursorEvent("\x1b[32mCloning repo...\x1b[0m", TASK_ID);
    expect(entries[0]).toMatchObject({ type: "text", content: "Cloning repo..." });
  });

  it("skips blank and near-empty lines", () => {
    expect(parseCursorEvent("", TASK_ID).entries).toEqual([]);
    expect(parseCursorEvent("  \r", TASK_ID).entries).toEqual([]);
  });

  it("skips unknown JSON events", () => {
    expect(parseCursorEvent(JSON.stringify({ type: "mystery" }), TASK_ID).entries).toEqual([]);
  });
});
