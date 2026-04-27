import type { AgentLogEntry } from "@optio/shared";

/**
 * Parse a single NDJSON line from Claude Code's --verbose stream-json output.
 *
 * Event types:
 * - { type: "system", subtype: "init", session_id, model, tools, ... }
 * - { type: "assistant", message: { content: [{ type: "thinking"|"text"|"tool_use" }] }, session_id }
 * - { type: "user", message: { content: [{ type: "tool_result" }] }, session_id }
 * - { type: "result", result: "...", total_cost_usd, num_turns, session_id }
 * - { type: "rate_limit_event", ... }
 *
 * Returns multiple entries per line (one per content block) since an assistant
 * message can contain thinking + tool_use in one event.
 */
export function parseClaudeEvent(
  line: string,
  taskId: string,
): { entries: AgentLogEntry[]; sessionId?: string; isTerminal?: boolean } {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    // Not JSON — raw text from shell/git
    if (!line.trim()) return { entries: [] };
    // Filter out terminal control sequences
    const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]|\r/g, "").trim();
    if (!clean || clean.length < 2) return { entries: [] };
    return {
      entries: [{ taskId, timestamp: new Date().toISOString(), type: "text", content: clean }],
    };
  }

  const sessionId = event.session_id as string | undefined;
  const timestamp = new Date().toISOString();
  const entries: AgentLogEntry[] = [];

  // System init event
  if (event.type === "system" && event.subtype === "init") {
    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "system",
      content: `Session started · ${event.model ?? "unknown"} · ${(event.tools ?? []).length} tools`,
      metadata: { model: event.model },
    });
    return { entries, sessionId };
  }

  // Other system events
  if (event.type === "system") {
    const msg = event.subtype ? `[${event.subtype}] ${event.error ?? ""}`.trim() : "";
    if (msg) {
      entries.push({ taskId, timestamp, sessionId, type: "system", content: msg });
    }
    return { entries, sessionId };
  }

  // Assistant message — the main event type
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "thinking" && block.thinking) {
        entries.push({
          taskId,
          timestamp,
          sessionId,
          type: "thinking",
          content: block.thinking,
        });
      } else if (block.type === "text" && block.text) {
        entries.push({
          taskId,
          timestamp,
          sessionId,
          type: "text",
          content: block.text,
        });
      } else if (block.type === "tool_use") {
        entries.push({
          taskId,
          timestamp,
          sessionId,
          type: "tool_use",
          content: formatToolUse(block.name, block.input),
          metadata: {
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
          },
        });
      }
    }
    return { entries, sessionId };
  }

  // User message (tool results)
  if (event.type === "user" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_result") {
        const raw =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: any) => c.text ?? c.content ?? "").join("")
              : "";
        // Use a higher limit for structured JSON output (e.g. review drafts)
        const limit = raw.includes('"verdict"') ? 5000 : 300;
        const trimmed = raw.length > limit ? raw.slice(0, limit) + "…" : raw;
        if (trimmed.trim()) {
          entries.push({
            taskId,
            timestamp,
            sessionId,
            type: "tool_result",
            content: trimmed,
          });
        }
      }
    }
    return { entries, sessionId };
  }

  // Result event (final summary) — terminal: after this claude has finished
  // the turn and, with --input-format stream-json, will sit idle waiting for
  // another user message. The task worker closes stdin when it sees this so
  // claude exits cleanly.
  //
  // We deliberately do NOT include `event.result` (the final assistant text)
  // in the entry content: that same text was already streamed via an
  // `assistant` text block, so echoing it here would render the agent's last
  // line twice in chat — once plain, once green-tinted from the info-type
  // "final answer" highlight.
  if (event.type === "result") {
    const meta: string[] = [];
    if (event.num_turns) meta.push(`${event.num_turns} turns`);
    if (event.duration_ms) meta.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
    if (event.total_cost_usd) meta.push(`$${event.total_cost_usd.toFixed(4)}`);
    const content = meta.length ? `(${meta.join(" · ")})` : "";

    entries.push({
      taskId,
      timestamp,
      sessionId,
      type: "info",
      content,
      metadata: {
        cost: event.total_cost_usd,
        turns: event.num_turns,
        durationMs: event.duration_ms,
        isError: event.is_error,
      },
    });
    return { entries, sessionId, isTerminal: true };
  }

  // Skip rate_limit_event, stream_event, etc.
  return { entries: [], sessionId };
}

/** Format a tool use into a concise human-readable string */
function formatToolUse(name: string, input: any): string {
  if (!input) return name;
  switch (name) {
    case "Read":
      return `Read ${input.file_path ?? ""}`;
    case "Write":
      return `Write ${input.file_path ?? ""}`;
    case "Edit":
      return `Edit ${input.file_path ?? ""}`;
    case "Bash":
      return `$ ${(input.command ?? "").split("\n")[0].slice(0, 120)}`;
    case "Glob":
      return `Glob ${input.pattern ?? ""}${input.path ? ` in ${input.path}` : ""}`;
    case "Grep":
      return `Grep "${input.pattern ?? ""}"${input.path ? ` in ${input.path}` : ""}`;
    case "WebSearch":
      return `Search: ${input.query ?? ""}`;
    case "WebFetch":
      return `Fetch: ${input.url ?? ""}`;
    case "Agent":
      return `Agent: ${input.description ?? ""}`;
    default:
      return name;
  }
}
