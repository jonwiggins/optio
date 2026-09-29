import { createHash } from "node:crypto";
import {
  LOCAL_TRANSCRIPT_DETAIL_MAX,
  LOCAL_TRANSCRIPT_TEXT_MAX,
  type LocalTranscriptEntry,
} from "@optio/shared";

/**
 * Distills a Codex session rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/
 * rollout-<time>-<thread id>.jsonl`) into the same conversation entries the
 * Claude Code transcript gives: prompts, replies, reasoning summaries, tool
 * calls with their results.
 *
 * A rollout carries the conversation twice. `response_item` lines are what
 * the model sees — including the context Codex injects as "user" messages
 * (`<environment_context>`, AGENTS.md, IDE context, `<turn_aborted>`).
 * `event_msg` lines are what the TUI shows: `user_message` is exactly what
 * the person typed, `agent_message` / `agent_reasoning` what the assistant
 * said. Text comes from the events, tool calls and their outputs from the
 * response items (the events only summarize those), so nothing shows twice.
 *
 * Codex's lines carry no ids; each is keyed by a hash of the line, which is
 * enough to drop a line the tracker happens to read twice.
 */

type Entry = Omit<LocalTranscriptEntry, "seq"> & { uuid: string | null };

const RESULT_TEXT_MAX = 4 * 1024;
const SUMMARY_MAX = 400;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `\n… (${text.length - max} more characters)`;
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

function oneLine(text: string): string {
  return clip(text.replace(/\s+/g, " ").trim(), SUMMARY_MAX);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A command given as argv (`["bash", "-lc", "ls"]`) as the line the shell ran. */
function commandLine(command: unknown): string {
  if (typeof command === "string") return command;
  if (!Array.isArray(command)) return "";
  const argv = command.map(String);
  if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) {
    return argv[2]!;
  }
  return argv.join(" ");
}

/** The files an apply_patch touches, from its `*** Add/Update/Delete File:` headers. */
function patchFiles(patch: string): string {
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) =>
    m[1]!.trim(),
  );
  return files.join(", ");
}

/**
 * A code-mode `exec` cell is JavaScript calling Codex's tools
 * (`tools.exec_command({cmd: …})`, `tools.web__run({search_query: …})`).
 * Name it after the tool it calls and the command or query it passes.
 */
function codeModeCall(code: string): { toolName: string; summary: string } {
  const tool = /tools\.([A-Za-z_][\w]*)\s*\(/.exec(code)?.[1] ?? null;
  const quoted = (key: string) =>
    new RegExp(`["']?${key}["']?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`).exec(
      code,
    )?.[1];
  const unquote = (s: string | undefined) => {
    if (!s) return null;
    const parsed = s.startsWith('"') ? parseJson(s) : s.slice(1, -1);
    return typeof parsed === "string" ? parsed : null;
  };
  if (tool === "exec_command") {
    const cmd = unquote(quoted("cmd"));
    if (cmd) return { toolName: "Shell", summary: cmd };
  }
  if (tool === "web__run" || tool === "web_search") {
    const q = unquote(quoted("q")) ?? unquote(quoted("query")) ?? unquote(quoted("ref_id"));
    if (q) return { toolName: "WebSearch", summary: q };
  }
  const firstLine = code.split("\n").find((l) => l.trim()) ?? "";
  return { toolName: tool ? `exec · ${tool}` : "exec", summary: firstLine };
}

/** Tool name as shown, and the one-line summary of what it was asked to do. */
export function describeCodexCall(
  name: string,
  input: unknown,
): { toolName: string; summary: string } {
  const args = typeof input === "string" ? (parseJson(input) ?? input) : input;
  const a = obj(args);
  switch (name) {
    case "exec_command":
      return { toolName: "Shell", summary: str(a.cmd) || commandLine(a.command) };
    case "shell":
    case "container.exec":
    case "local_shell":
      return { toolName: "Shell", summary: commandLine(a.command) };
    case "write_stdin":
      return {
        toolName: "Shell",
        summary: str(a.chars) ? `input → ${JSON.stringify(str(a.chars))}` : "wait for output",
      };
    case "apply_patch": {
      const patch = typeof args === "string" ? args : str(a.input) || str(a.patch);
      return { toolName: "Patch", summary: patchFiles(patch) || "apply a patch" };
    }
    case "update_plan": {
      const steps = Array.isArray(a.plan) ? a.plan.length : 0;
      return {
        toolName: "Plan",
        summary: str(a.explanation) || (steps ? `${steps} steps` : "update the plan"),
      };
    }
    case "view_image":
      return { toolName: "ViewImage", summary: str(a.path) };
    case "exec":
      return typeof args === "string"
        ? codeModeCall(args)
        : { toolName: "exec", summary: JSON.stringify(a) };
    case "spawn_agent":
    case "send_message":
    case "followup_task":
    case "wait_agent":
    case "list_agents":
    case "interrupt_agent":
    case "close_agent":
      // Their messages are encrypted; the task / target names what happened.
      return {
        toolName: "Agent",
        summary: [name.replace(/_/g, " "), str(a.task_name) || str(a.target)]
          .filter(Boolean)
          .join(" · "),
      };
    default: {
      let summary = "";
      if (typeof args === "string") summary = args;
      else {
        try {
          summary = JSON.stringify(args ?? {});
        } catch {
          summary = "";
        }
      }
      return { toolName: name.slice(0, 100), summary };
    }
  }
}

/**
 * A tool's output as text, and whether it failed. Codex frames command
 * output with a header ("Process exited with code 1", "Exit code: 0",
 * "Script completed", `{"output", "metadata": {"exit_code"}}`); the header
 * goes, the exit code decides `isError`.
 */
export function codexOutput(output: unknown): { text: string; isError: boolean } {
  let text: string;
  if (Array.isArray(output)) {
    text = output
      .map((item) => {
        const o = obj(item);
        if (typeof o.text === "string") return o.text;
        if (o.type === "input_image") return "[image]";
        return "";
      })
      .join("\n");
  } else if (output && typeof output === "object") {
    const o = obj(output);
    text = str(o.content) || str(o.output) || JSON.stringify(o);
  } else {
    text = str(output);
  }

  let isError = false;
  const asJson = text.trimStart().startsWith("{") ? obj(parseJson(text)) : {};
  if (typeof asJson.output === "string" && asJson.metadata && typeof asJson.metadata === "object") {
    const code = obj(asJson.metadata).exit_code;
    return { text: asJson.output, isError: typeof code === "number" && code !== 0 };
  }
  const exit = /^(?:Process exited with code|Exit code:)\s*(-?\d+)/m.exec(text);
  if (exit) isError = Number(exit[1]) !== 0;
  else if (/^[^\n]*\b(?:failed|error)\b/i.test(text)) isError = true;
  // Drop the framing header ("Chunk ID / Wall time / … / Output:").
  const body =
    /^(?:(?:Chunk ID|Wall time|Process exited|Exit code|Original token count|Script (?:completed|running)|Total output lines)[^\n]*\n)+Output:\n/.exec(
      text,
    );
  if (body) text = text.slice(body[0].length);
  return { text: text.replace(/^\n+/, ""), isError };
}

/** The entries one rollout line contributes, in order, without `seq`. */
export function entriesFromCodexLine(line: string): Entry[] | null {
  const d = obj(parseJson(line));
  const type = str(d.type);
  if (type !== "event_msg" && type !== "response_item") return null;
  const p = obj(d.payload);
  const at = typeof d.timestamp === "string" ? d.timestamp : null;
  const uuid = createHash("sha1").update(line).digest("hex");
  const base = {
    detail: null,
    toolName: null,
    toolUseId: null,
    isError: false,
    source: null,
    at,
    uuid,
  };
  const text = (value: string) => clip(value, LOCAL_TRANSCRIPT_TEXT_MAX);

  if (type === "event_msg") {
    switch (str(p.type)) {
      case "user_message": {
        const images =
          (Array.isArray(p.images) ? p.images.length : 0) +
          (Array.isArray(p.local_images) ? p.local_images.length : 0);
        const message = str(p.message).trim();
        const body = [message, images ? `[${images} image${images === 1 ? "" : "s"}]` : ""]
          .filter(Boolean)
          .join("\n");
        return body ? [{ ...base, role: "user", kind: "text", text: text(body) }] : [];
      }
      case "agent_message": {
        const message = str(p.message);
        return message.trim()
          ? [{ ...base, role: "assistant", kind: "text", text: text(message) }]
          : [];
      }
      case "agent_reasoning": {
        const thought = str(p.text);
        return thought.trim()
          ? [{ ...base, role: "assistant", kind: "thinking", text: text(thought) }]
          : [];
      }
      case "turn_aborted":
        return [
          {
            ...base,
            role: "system",
            kind: "text",
            source: "interrupt",
            text:
              str(p.reason) === "interrupted" || !p.reason
                ? "Turn interrupted"
                : `Turn ended: ${str(p.reason)}`,
          },
        ];
      case "context_compacted":
        return [
          {
            ...base,
            role: "system",
            kind: "text",
            source: "compact",
            text: "The conversation so far was summarized to free up context",
          },
        ];
      case "thread_rolled_back": {
        const n = typeof p.num_turns === "number" ? p.num_turns : null;
        return [
          {
            ...base,
            role: "system",
            kind: "text",
            source: "rewind",
            text: n
              ? `Rolled back ${n} turn${n === 1 ? "" : "s"}`
              : "Rolled back to an earlier turn",
          },
        ];
      }
      default:
        return null;
    }
  }

  // response_item: tool calls and their outputs.
  const callId = str(p.call_id) || str(p.id) || null;
  switch (str(p.type)) {
    case "function_call":
    case "custom_tool_call": {
      const name = str(p.name);
      if (!name) return null;
      const input = p.type === "function_call" ? p.arguments : p.input;
      const { toolName, summary } = describeCodexCall(name, input);
      let detail: string | null = null;
      if (typeof input === "string") {
        const parsed = parseJson(input);
        detail = parsed && typeof parsed === "object" ? JSON.stringify(parsed, null, 2) : input;
      } else if (input !== undefined) {
        detail = JSON.stringify(input, null, 2);
      }
      return [
        {
          ...base,
          role: "assistant",
          kind: "tool_use",
          text: oneLine(summary),
          detail: detail === null ? null : clip(detail, LOCAL_TRANSCRIPT_DETAIL_MAX),
          toolName,
          toolUseId: callId,
        },
      ];
    }
    case "local_shell_call": {
      const action = obj(p.action);
      return [
        {
          ...base,
          role: "assistant",
          kind: "tool_use",
          text: oneLine(commandLine(action.command)),
          detail: clip(JSON.stringify(action, null, 2), LOCAL_TRANSCRIPT_DETAIL_MAX),
          toolName: "Shell",
          toolUseId: callId,
        },
      ];
    }
    case "web_search_call": {
      const action = obj(p.action);
      const what = str(action.query) || str(action.url) || str(action.pattern) || "search";
      // Codex keeps the results to itself; the call alone says what was looked up.
      return [
        {
          ...base,
          role: "assistant",
          kind: "tool_use",
          text: oneLine(what),
          toolName: "WebSearch",
          toolUseId: null,
        },
      ];
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const { text: out, isError } = codexOutput(p.output);
      return [
        {
          ...base,
          role: "tool",
          kind: "tool_result",
          text: clip(out, RESULT_TEXT_MAX),
          toolUseId: callId,
          isError,
        },
      ];
    }
    default:
      return null;
  }
}

/**
 * The first line of a rollout: its thread id, and whether it is a subagent's
 * thread (forked from another, which is the one the person talks to).
 */
export function codexSessionMeta(
  line: string,
): { id: string; cwd: string | null; subagent: boolean } | null {
  const d = obj(parseJson(line));
  if (d.type !== "session_meta") return null;
  const p = obj(d.payload);
  const id = str(p.id) || str(p.session_id);
  if (!id) return null;
  const source = p.source;
  const subagent =
    (source !== null && typeof source === "object" && "subagent" in (source as Obj)) ||
    !!str(p.parent_thread_id);
  return { id, cwd: str(p.cwd) || null, subagent };
}

/** A rollout file's thread id, from its name (`rollout-<time>-<uuid>.jsonl`). */
export function codexThreadIdFromPath(path: string): string | null {
  return (
    /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
      path,
    )?.[1] ?? null
  );
}
