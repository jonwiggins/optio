import type { LocalTranscriptSource } from "../types/local.js";

/**
 * Agent CLIs file more than the person's messages as "user" turns: a
 * background task reporting back, another agent session's message, the
 * summary that replaced a compacted conversation, the note left by an
 * interrupted turn. Those must not read as "You" in a conversation view.
 *
 * This tells them apart by their text alone — what's left to go on for a
 * conversation stored before the daemon tagged each entry's source, and a
 * fallback for CLI versions that don't record where a turn came from. The
 * daemon prefers the transcript's own metadata when there is some.
 */
export interface ClassifiedTurn {
  source: LocalTranscriptSource;
  /** What to show: the notification's summary and result, the other agent's message, … */
  text: string;
}

const COMPACT_SUMMARY_RE = /^This session is being continued from a previous conversation/;
const INTERRUPTED_RE = /^\[(Request interrupted by user[^\]\n]*)\]$/;
const PEER_PREFIX = "Another Claude session sent a message:";

function tag(text: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  const value = m?.[1]?.trim();
  return value ? value : null;
}

/** `<task-notification>` → its summary line, then the result it carried. */
export function taskNotificationText(text: string): string {
  const summary = tag(text, "summary") ?? tag(text, "status") ?? "A background task finished";
  const result = tag(text, "result");
  return result ? `${summary}\n\n${result}` : summary;
}

/** "Another Claude session sent a message: <agent-message from=…>…" → the message, signed. */
export function peerMessageText(text: string, sender?: string | null): string {
  const m = /<agent-message(?:\s+from="([^"]*)")?\s*>([\s\S]*?)(?:<\/agent-message>|$)/.exec(text);
  const body = (m?.[2] ?? text.slice(PEER_PREFIX.length)).trim();
  const from = sender?.trim() || m?.[1]?.trim();
  return from ? `${from}: ${body}` : body;
}

/**
 * Where a "user" turn came from, judged by its text; null when it reads as
 * something the person typed.
 */
export function classifyTranscriptUserText(text: string): ClassifiedTurn | null {
  const t = text.trim();
  if (t.startsWith("<task-notification>")) {
    return { source: "task", text: taskNotificationText(t) };
  }
  if (t.startsWith(PEER_PREFIX) || t.startsWith("<agent-message")) {
    return { source: "agent", text: peerMessageText(t) };
  }
  if (COMPACT_SUMMARY_RE.test(t)) return { source: "compact", text: t };
  const interrupted = INTERRUPTED_RE.exec(t);
  if (interrupted) return { source: "interrupt", text: interrupted[1]! };
  return null;
}
