import { describe, it, expect } from "vitest";
import { getEventParser } from "./event-parsers.js";
import { parseClaudeEvent } from "./agent-event-parser.js";
import { parseCodexEvent } from "./codex-event-parser.js";
import { parseCopilotEvent } from "./copilot-event-parser.js";
import { parseCursorEvent } from "./cursor-event-parser.js";
import { parseGeminiEvent } from "./gemini-event-parser.js";
import { parseOpenClawEvent } from "./openclaw-event-parser.js";
import { parseOpenCodeEvent } from "./opencode-event-parser.js";

describe("getEventParser", () => {
  it.each([
    ["claude-code", parseClaudeEvent],
    ["codex", parseCodexEvent],
    ["copilot", parseCopilotEvent],
    ["opencode", parseOpenCodeEvent],
    ["gemini", parseGeminiEvent],
    ["openclaw", parseOpenClawEvent],
    ["cursor", parseCursorEvent],
  ])("picks the %s parser", (agentType, parser) => {
    expect(getEventParser(agentType)).toBe(parser);
  });

  it("falls back to the Claude parser for unknown or missing types", () => {
    expect(getEventParser("something-new")).toBe(parseClaudeEvent);
    expect(getEventParser(undefined)).toBe(parseClaudeEvent);
    expect(getEventParser(null)).toBe(parseClaudeEvent);
  });
});
