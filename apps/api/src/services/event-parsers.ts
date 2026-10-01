import type { AgentLogEntry } from "@optio/shared";
import { parseClaudeEvent } from "./agent-event-parser.js";
import { parseCodexEvent } from "./codex-event-parser.js";
import { parseCopilotEvent } from "./copilot-event-parser.js";
import { parseCursorEvent } from "./cursor-event-parser.js";
import { parseGeminiEvent } from "./gemini-event-parser.js";
import { parseOpenClawEvent } from "./openclaw-event-parser.js";
import { parseOpenCodeEvent } from "./opencode-event-parser.js";

export type AgentEventParser = (
  line: string,
  id: string,
) => { entries: AgentLogEntry[]; sessionId?: string; isTerminal?: boolean };

/**
 * The stdout event parser for an agent type. The one place every worker
 * (task, workflow, persistent-agent, pr-review) picks it, so a new agent
 * can't be wired into one worker and silently fall through to Claude's
 * parser in another. Unknown / missing types use the Claude parser.
 */
export function getEventParser(agentType: string | null | undefined): AgentEventParser {
  switch (agentType) {
    case "codex":
      return parseCodexEvent;
    case "copilot":
      return parseCopilotEvent;
    case "opencode":
      return parseOpenCodeEvent;
    case "gemini":
      return parseGeminiEvent;
    case "openclaw":
      return parseOpenClawEvent;
    case "cursor":
      return parseCursorEvent;
    default:
      return parseClaudeEvent;
  }
}
