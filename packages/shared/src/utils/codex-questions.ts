import type { LocalTranscriptEntry } from "../types/local.js";

/** Codex 0.166 async questions. Blocking request_user_input uses a different RPC. */
export interface CodexQuestion {
  id: string;
  title: string;
  options: string[];
  answer: string | null;
}

export interface CodexQuestionReply {
  answer: string;
  question: string;
  questionItemId: string;
}

const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Accept only complete structured calls, never prose that happens to mention a tool. */
export function codexQuestions(
  entry: Pick<LocalTranscriptEntry, "kind" | "toolName" | "toolUseId" | "detail">,
): CodexQuestion[] {
  if (
    entry.kind !== "tool_use" ||
    entry.toolName !== "request_user_input_async" ||
    !entry.toolUseId ||
    !entry.detail
  )
    return [];
  try {
    const questions = object(JSON.parse(entry.detail))?.questions;
    if (!Array.isArray(questions) || !questions.length) return [];
    const out: CodexQuestion[] = [];
    for (const [index, value] of questions.entries()) {
      const q = object(value);
      if (!q || typeof q.title !== "string" || !q.title.trim()) return [];
      if (
        q.options != null &&
        (!Array.isArray(q.options) || !q.options.every((o) => typeof o === "string" && o.trim()))
      )
        return [];
      out.push({
        id: JSON.stringify(["request_user_input_async", entry.toolUseId, index]),
        title: q.title,
        options: (q.options as string[] | null) ?? [],
        answer: null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** The wrapper is a Codex client convention, not a Responses API tool result. */
export function codexQuestionReplies(text: string): CodexQuestionReply[] | null {
  const body = text.trim();
  if (!body.startsWith(OPEN) || !body.endsWith(CLOSE)) return null;
  try {
    const replies: unknown = JSON.parse(body.slice(OPEN.length, -CLOSE.length));
    if (!Array.isArray(replies) || !replies.length) return null;
    return replies.every((r) => {
      const v = object(r);
      return (
        v &&
        typeof v.answer === "string" &&
        typeof v.question === "string" &&
        typeof v.questionItemId === "string"
      );
    })
      ? (replies as CodexQuestionReply[])
      : null;
  } catch {
    return null;
  }
}

export function codexQuestionReplyText(question: CodexQuestion, answer: string): string {
  // One physical line for terminal composers. Escaping '<' keeps answer text
  // containing the closing tag inside the JSON rather than ending the envelope.
  return (
    OPEN +
    JSON.stringify([{ answer, question: question.title, questionItemId: question.id }]).replaceAll(
      "<",
      "\\u003c",
    ) +
    CLOSE
  );
}

/** Answers from any client (including the terminal) settle the same question. */
export function pendingCodexQuestions(entries: LocalTranscriptEntry[]): CodexQuestion[] {
  const pending = new Map<string, CodexQuestion>();
  for (const entry of entries) {
    if (entry.role === "system" && entry.source === "rewind") pending.clear();
    for (const q of codexQuestions(entry)) if (!pending.has(q.id)) pending.set(q.id, q);
    if (entry.role === "user") {
      for (const reply of codexQuestionReplies(entry.text) ?? []) {
        const q = pending.get(reply.questionItemId);
        if (q && q.title === reply.question) q.answer = reply.answer;
      }
    }
  }
  return [...pending.values()].filter((q) => q.answer === null);
}

export function codexReplyDisplayText(text: string): string {
  return (
    codexQuestionReplies(text)
      ?.map((r) => `${r.question}\n${r.answer}`)
      .join("\n\n") ?? text
  );
}
