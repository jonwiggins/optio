import type { AgentLogEntry } from "@optio/shared";

/**
 * Parse a single NDJSON line from OpenClaw's `agent --output-format stream-json` output.
 *
 * OpenClaw outputs events as one JSON object per line, similar to Claude Code's
 * NDJSON format. This parser is designed to be tolerant of unknown event types.
 *
 * Known shapes:
 * - { type: "system", subtype: "init", session_id, model, version }
 * - { type: "message", role: "assistant"|"system", content: "...", session_id }
 * - { type: "tool_call", name: "...", call_id: "...", arguments: "..." }
 * - { type: "tool_result", call_id: "...", output: "..." }
 * - { type: "error", message: "..." }
 * - { type: "result", result: "...", total_cost_usd, session_id }
 * - Events with usage data (input_tokens, output_tokens)
 */
export function parseOpenClawEvent(
  line: string,
  taskId: string,
): { entries: AgentLogEntry[]; sessionId?: string; isTerminal?: boolean } {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    // Not JSON — raw text from shell/git
    if (!line.trim()) return { entries: [] };
    const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]|\r/g, "").trim();
    if (!clean || clean.length < 2) return { entries: [] };
    return {
      entries: [{ taskId, timestamp: new Date().toISOString(), type: "text", content: clean }],
    };
  }

  const timestamp = new Date().toISOString();
  const entries: AgentLogEntry[] = [];

  // Extract session/conversation ID if present
  const sessionId = (event.session_id ?? event.id ?? event.conversation_id) as string | undefined;

  // System message or init
  if (event.type === "message" && event.role === "system") {
    const content =
      typeof event.content === "string" ? event.content : JSON.stringify(event.content);
    if (content?.trim()) {
      entries.push({ taskId, timestamp, sessionId, type: "system", content });
    }
    return { entries, sessionId };
  }

  // System init event (model info)
  if (event.type === "system" && event.subtype === "init") {
    const parts: string[] = [];
    if (event.model) parts.push(`Model: ${event.model}`);
    if (event.version) parts.push(`OpenClaw v${event.version}`);
    if (parts.length) {
      entries.push({ taskId, timestamp, sessionId, type: "system", content: parts.join(" · ") });
    }
    return { entries, sessionId };
  }

  // Assistant message
  if (event.type === "message" && event.role === "assistant") {
    const content =
      typeof event.content === "string"
        ? event.content
        : Array.isArray(event.content)
          ? event.content
              .map((block: any) => {
                if (typeof block === "string") return block;
                if (block.type === "text") return block.text;
                if (block.type === "output_text") return block.text;
                return "";
              })
              .filter(Boolean)
              .join("\n")
          : "";
    if (content?.trim()) {
      entries.push({ taskId, timestamp, sessionId, type: "text", content });
    }

    // Check for usage data in the message event
    const usage = event.usage ?? event.response?.usage;
    if (usage) {
      const meta: string[] = [];
      const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
      if (inputTokens) meta.push(`${inputTokens} input tokens`);
      if (outputTokens) meta.push(`${outputTokens} output tokens`);
      if (event.total_cost_usd) meta.push(`$${event.total_cost_usd.toFixed(4)}`);
      if (meta.length) {
        entries.push({
          taskId,
          timestamp,
          sessionId,
          type: "info",
          content: `Usage: ${meta.join(" · ")}`,
          metadata: { inputTokens, outputTokens, cost: event.total_cost_usd },
        });
      }
    }
    return { entries, sessionId };
  }

  // Tool call (tool use) — OpenClaw may use "tool_call" or "function_call"
  if (event.type === "tool_call" || event.type === "function_call") {
    const args = parseArgs(event.arguments);
    const formatted = formatToolUse(event.name, args);
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "tool_use",
      content: formatted,
      metadata: { toolName: event.name, toolInput: args, toolUseId: event.call_id },
    });
    return { entries, sessionId };
  }

  // Tool result — OpenClaw may use "tool_result" or "function_call_output"
  if (event.type === "tool_result" || event.type === "function_call_output") {
    const output = typeof event.output === "string" ? event.output : JSON.stringify(event.output);
    const trimmed = output.length > 300 ? output.slice(0, 300) + "\u2026" : output;
    if (trimmed.trim()) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "tool_result",
        content: trimmed,
        metadata: { toolUseId: event.call_id },
      });
    }
    return { entries, sessionId };
  }

  // Error event
  if (event.type === "error") {
    const msg = event.message ?? event.error ?? JSON.stringify(event);
    entries.push({ taskId, timestamp, sessionId, type: "error", content: msg });
    return { entries, sessionId };
  }

  // Result/summary event
  if (event.type === "result") {
    const result = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
    if (result.trim()) {
      entries.push({ taskId, timestamp, sessionId, type: "text", content: result });
    }
    if (event.total_cost_usd != null) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "info",
        content: `Total cost: $${event.total_cost_usd.toFixed(4)}`,
        metadata: { cost: event.total_cost_usd },
      });
    }
    return { entries, sessionId };
  }

  // Reasoning/thinking event
  if (event.type === "reasoning") {
    const content = typeof event.content === "string" ? event.content : "";
    if (content.trim()) {
      entries.push({ taskId, timestamp, sessionId, type: "thinking", content });
    }
    return { entries, sessionId };
  }

  // Generic event with usage data
  if (event.usage || event.response?.usage) {
    const usage = event.usage ?? event.response.usage;
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
    const meta: string[] = [];
    if (inputTokens) meta.push(`${inputTokens} input tokens`);
    if (outputTokens) meta.push(`${outputTokens} output tokens`);
    if (event.total_cost_usd) meta.push(`$${event.total_cost_usd.toFixed(4)}`);
    if (meta.length) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "info",
        content: `Usage: ${meta.join(" · ")}`,
        metadata: { inputTokens, outputTokens, cost: event.total_cost_usd },
      });
    }
    return { entries, sessionId };
  }

  // Unknown JSON event — skip silently
  return { entries: [], sessionId };
}

function parseArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args) return undefined;
  if (typeof args === "object") return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return { raw: args };
    }
  }
  return undefined;
}

function formatToolUse(name: string, args: Record<string, unknown> | undefined): string {
  if (!name) return "unknown tool";
  if (!args) return name;

  switch (name) {
    case "shell":
    case "bash":
    case "terminal":
      return `$ ${String(args.command ?? args.cmd ?? "")
        .split("\n")[0]
        .slice(0, 120)}`;
    case "read_file":
    case "readFile":
      return `Read ${args.path ?? args.file_path ?? ""}`;
    case "write_file":
    case "writeFile":
    case "create_file":
      return `Write ${args.path ?? args.file_path ?? ""}`;
    case "edit_file":
    case "editFile":
    case "apply_diff":
      return `Edit ${args.path ?? args.file_path ?? ""}`;
    case "search":
    case "grep":
      return `Search: ${args.query ?? args.pattern ?? ""}`;
    case "list_dir":
    case "listDir":
      return `List ${args.path ?? args.dir ?? "."}`;
    default:
      return name;
  }
}
