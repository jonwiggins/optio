import {
  LOCAL_TRANSCRIPT_DETAIL_MAX,
  LOCAL_TRANSCRIPT_MAX_ENTRIES,
  LOCAL_TRANSCRIPT_TEXT_MAX,
  type LocalTranscriptEntry,
} from "@optio/shared";
import { JsonlTail } from "./jsonl-tail.js";

/**
 * Distills a Claude Code transcript (the JSONL at the hooks'
 * `transcript_path`) into the conversation the cockpit shows after the
 * session ends: prompts, replies, tool calls with their results, thinking.
 *
 * The terminal's screen is no substitute — Claude Code draws a full-screen
 * TUI, so the bytes that survive its exit are one redraw of the last
 * screen, not the scrollback. The transcript is the source of truth for
 * "what was said and done", and as plain text it reflows to a phone.
 *
 * Reads are incremental (JsonlTail). Lines are deduplicated by `uuid`, so a
 * transcript that is re-read from the top (rewritten file) yields no
 * duplicates. Subagent (sidechain) lines are skipped: they are a tool's
 * internals, and the parent's Agent tool call + result already covers them.
 */

/** Tool-result text longer than this is cut (the full output was on screen at the time). */
const RESULT_TEXT_MAX = 4 * 1024;
const SUMMARY_MAX = 400;

interface TerminalTranscriptState {
  transcriptPath: string;
  tail: JsonlTail;
  seen: Set<string>;
  nextSeq: number;
}

/** Truncate with a marker, keeping the result under `max` characters. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = `\n… (${text.length - max} more characters)`;
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** Text of a user / tool-result content value (string, or a list of text blocks). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Claude Code writes its own bookkeeping as user lines: slash-command
 * echoes, local-command output, the "caveat" preamble, system reminders.
 * Those aren't things the person said.
 */
const META_TAG_RE =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr)>/;

/** One-line summary of a tool call's input, for the collapsed row. */
export function summarizeToolInput(name: string, input: unknown): string {
  const inp = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (k: string) => (typeof inp[k] === "string" ? (inp[k] as string) : null);
  let summary: string | null = null;
  switch (name) {
    case "Bash":
      summary = str("description") ?? str("command");
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      summary = str("file_path") ?? str("notebook_path");
      break;
    case "Grep":
    case "Glob":
      summary = [str("pattern"), str("path")].filter(Boolean).join(" in ");
      break;
    case "Agent":
    case "Task":
      summary = str("description") ?? str("prompt");
      break;
    case "WebFetch":
    case "WebSearch":
      summary = str("url") ?? str("query");
      break;
    case "Skill":
      summary = str("skill");
      break;
    default:
      summary = str("description") ?? str("command") ?? str("file_path") ?? str("query");
  }
  if (!summary) {
    try {
      summary = JSON.stringify(inp);
    } catch {
      summary = "";
    }
  }
  return clip(summary.replace(/\s+/g, " ").trim(), SUMMARY_MAX);
}

/**
 * The entries one transcript line contributes, in order, without `seq`
 * (assigned by the tracker). Exported for tests.
 */
export function entriesFromLine(
  line: string,
): Array<Omit<LocalTranscriptEntry, "seq"> & { uuid: string | null }> | null {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object") return null;
  if (d.isSidechain === true) return null;
  const msg = d.message;
  if (!msg || typeof msg !== "object") return null;
  const uuid = typeof d.uuid === "string" ? d.uuid : null;
  const at = typeof d.timestamp === "string" ? d.timestamp : null;
  const out: Array<Omit<LocalTranscriptEntry, "seq"> & { uuid: string | null }> = [];
  const base = { detail: null, toolName: null, toolUseId: null, isError: false, at, uuid };

  if (d.type === "user") {
    if (d.isMeta === true) return null;
    if (typeof msg.content === "string") {
      const text = msg.content.trim();
      if (text && !META_TAG_RE.test(text)) {
        out.push({
          ...base,
          role: "user",
          kind: "text",
          text: clip(text, LOCAL_TRANSCRIPT_TEXT_MAX),
        });
      }
      return out;
    }
    if (!Array.isArray(msg.content)) return null;
    const texts: string[] = [];
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (block.type === "tool_result") {
        out.push({
          ...base,
          role: "tool",
          kind: "tool_result",
          text: clip(contentText(block.content), RESULT_TEXT_MAX),
          toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
          isError: block.is_error === true,
        });
      }
    }
    const text = texts.join("\n").trim();
    if (text && !META_TAG_RE.test(text)) {
      out.push({
        ...base,
        role: "user",
        kind: "text",
        text: clip(text, LOCAL_TRANSCRIPT_TEXT_MAX),
      });
    }
    return out;
  }

  if (d.type === "assistant") {
    if (!Array.isArray(msg.content)) return null;
    for (const block of msg.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({
          ...base,
          role: "assistant",
          kind: "text",
          text: clip(block.text, LOCAL_TRANSCRIPT_TEXT_MAX),
        });
      } else if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking.trim()
      ) {
        out.push({
          ...base,
          role: "assistant",
          kind: "thinking",
          text: clip(block.thinking, LOCAL_TRANSCRIPT_TEXT_MAX),
        });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        let detail: string | null = null;
        try {
          detail = clip(JSON.stringify(block.input ?? {}, null, 2), LOCAL_TRANSCRIPT_DETAIL_MAX);
        } catch {
          detail = null;
        }
        out.push({
          ...base,
          role: "assistant",
          kind: "tool_use",
          text: summarizeToolInput(block.name, block.input),
          detail,
          toolName: block.name.slice(0, 100),
          toolUseId: typeof block.id === "string" ? block.id : null,
        });
      }
    }
    return out;
  }
  return null;
}

export class TranscriptTracker {
  private byTerminal = new Map<string, TerminalTranscriptState>();

  /** Terminals with a known transcript, for the daemon's periodic poll. */
  paths(): Array<[terminalId: string, transcriptPath: string]> {
    return [...this.byTerminal].map(([id, s]) => [id, s.transcriptPath]);
  }

  /**
   * Point a terminal at its transcript and return the entries appended since
   * the last call (empty when nothing new). A different transcript path
   * (`claude --resume` inside the same terminal) continues the numbering, so
   * the server sees one growing conversation.
   */
  update(terminalId: string, transcriptPath: string): LocalTranscriptEntry[] {
    let state = this.byTerminal.get(terminalId);
    if (!state) {
      state = { transcriptPath, tail: new JsonlTail(transcriptPath), seen: new Set(), nextSeq: 1 };
      this.byTerminal.set(terminalId, state);
    } else if (state.transcriptPath !== transcriptPath) {
      state.transcriptPath = transcriptPath;
      state.tail = new JsonlTail(transcriptPath);
    }
    if (state.nextSeq > LOCAL_TRANSCRIPT_MAX_ENTRIES) return [];
    const out: LocalTranscriptEntry[] = [];
    state.tail.readNew((line) => {
      const entries = entriesFromLine(line);
      if (!entries || entries.length === 0) return;
      for (const { uuid, ...entry } of entries) {
        // One line per content block, each with its own uuid; a line with
        // several blocks is keyed per block so none are lost.
        const key = uuid ? `${uuid}:${entry.kind}:${entry.toolUseId ?? ""}` : null;
        if (key) {
          if (state!.seen.has(key)) continue;
          state!.seen.add(key);
        }
        if (state!.nextSeq > LOCAL_TRANSCRIPT_MAX_ENTRIES) return;
        out.push({ seq: state!.nextSeq++, ...entry });
      }
    });
    return out;
  }

  remove(terminalId: string): void {
    this.byTerminal.delete(terminalId);
  }
}
