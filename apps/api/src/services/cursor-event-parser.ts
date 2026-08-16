import type { AgentLogEntry } from "@optio/shared";

/**
 * Parse a single NDJSON line from the Cursor CLI's --output-format stream-json
 * output (cursor-agent --print).
 *
 * Cursor emits one JSON object per line:
 * - { type: "system", subtype: "init", session_id, model, permissionMode, apiKeySource, cwd }
 * - { type: "user", message: { role: "user", content: [...] } }
 * - { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }
 * - { type: "tool_call", subtype: "started"|"completed", call_id, tool_call: { <name>ToolCall: { args, result? } } }
 * - { type: "result", subtype: "success", duration_ms, is_error, result, session_id }
 *
 * Returns the parsed entries plus the session id (from the init event) and
 * whether this was the terminal `result` event.
 */
export function parseCursorEvent(
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
  const sessionId = event.session_id as string | undefined;

  // Init event — session + model info
  if (event.type === "system" && event.subtype === "init") {
    const parts: string[] = ["Session initialized"];
    if (event.model) parts.push(`model: ${event.model}`);
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "system",
      content: parts.join(" · "),
      metadata: event.model ? { model: event.model } : undefined,
    });
    return { entries, sessionId };
  }

  // Assistant message — full accumulated text per segment
  if (event.type === "assistant") {
    const content = extractMessageText(event.message ?? event);
    if (content) {
      entries.push({
        taskId,
        timestamp,
        sessionId,
        type: "text",
        content,
      });
    }
    return { entries, sessionId };
  }

  // User messages are the prompt we sent — skip (already visible in the task)
  if (event.type === "user") {
    return { entries: [], sessionId };
  }

  // Tool call — paired started/completed events
  if (event.type === "tool_call") {
    const { name, args, output } = unpackToolCall(event.tool_call ?? event);
    if (event.subtype === "completed") {
      const trimmed = output && output.length > 300 ? output.slice(0, 300) + "…" : output;
      if (trimmed?.trim()) {
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
    // started (or unknown subtype) — render the invocation
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "tool_use",
      content: formatCursorToolUse(name, args),
      metadata: {
        toolName: name,
        toolInput: args,
        toolUseId: event.call_id,
      },
    });
    return { entries, sessionId };
  }

  // Error event
  if (event.type === "error") {
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "error",
      content: event.message ?? event.error ?? JSON.stringify(event),
    });
    return { entries, sessionId };
  }

  // Terminal result event
  if (event.type === "result") {
    const meta: string[] = [];
    if (typeof event.duration_ms === "number")
      meta.push(`${Math.round(event.duration_ms / 1000)}s`);
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: event.is_error ? "error" : "info",
      content: event.is_error
        ? typeof event.result === "string"
          ? event.result
          : "Agent reported an error"
        : `Result: ${["success", ...meta].join(" · ")}`,
      metadata: { durationMs: event.duration_ms },
    });
    return { entries, sessionId, isTerminal: true };
  }

  // Unknown JSON event — skip
  return { entries: [], sessionId };
}

/** Pull plain text out of a Cursor message ({content: string | block[]}) */
function extractMessageText(message: any): string | undefined {
  if (!message) return undefined;
  const content = message.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

/**
 * Unpack Cursor's tool_call payload. The payload nests tool-specific keys
 * like { readToolCall: { args: {...}, result: {...} } } — find the first
 * such key and pull out its args/result. Falls back to flat { name, args }.
 */
function unpackToolCall(toolCall: any): {
  name: string;
  args?: Record<string, unknown>;
  output?: string;
} {
  if (!toolCall || typeof toolCall !== "object") return { name: "unknown tool" };

  // Flat shape: { name, args/arguments, result/output }
  if (typeof toolCall.name === "string") {
    return {
      name: toolCall.name,
      args: asObject(toolCall.args ?? toolCall.arguments),
      output: asText(toolCall.result ?? toolCall.output),
    };
  }

  // Nested shape: { <name>ToolCall: { args, result } }
  for (const [key, value] of Object.entries(toolCall)) {
    if (key.endsWith("ToolCall") && value && typeof value === "object") {
      const inner = value as Record<string, unknown>;
      return {
        name: key.slice(0, -"ToolCall".length),
        args: asObject(inner.args ?? inner.arguments),
        output: asText(inner.result ?? inner.output),
      };
    }
  }

  return { name: "unknown tool" };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return { raw: value };
    }
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Format a Cursor tool call into a concise human-readable string */
function formatCursorToolUse(name: string, args: Record<string, unknown> | undefined): string {
  if (!name) return "unknown tool";
  if (!args) return name;

  switch (name) {
    case "shell":
    case "bash":
    case "terminal":
      return `$ ${String(args.command ?? args.cmd ?? "")
        .split("\n")[0]
        .slice(0, 120)}`;
    case "read":
    case "readFile":
      return `Read ${args.path ?? args.file_path ?? ""}`;
    case "write":
    case "writeFile":
      return `Write ${args.path ?? args.file_path ?? ""}`;
    case "edit":
    case "editFile":
    case "strReplace":
      return `Edit ${args.path ?? args.file_path ?? ""}`;
    case "grep":
    case "search":
      return `Search: ${args.query ?? args.pattern ?? ""}`;
    case "ls":
    case "listDir":
      return `List ${args.path ?? args.dir ?? "."}`;
    default:
      return name;
  }
}
