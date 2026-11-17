import { and, asc, eq, inArray, or } from "drizzle-orm";
import {
  classifyTranscriptUserText,
  pendingCodexQuestions,
  type LocalTranscriptEntry,
} from "@optio/shared";
import { db } from "../db/client.js";
import { localTerminalTranscripts as transcript } from "../db/schema.js";

/**
 * Questions are an attention overlay, not the agent's execution state. Derive
 * them from the stored transcript so older daemons, reconnects and API replicas
 * agree, and the latest daemon status reappears after the final answer.
 * Only question/reply/rewind entries are read, in one query for the whole list;
 * ordinary tool output and chat pagination cannot hide an unanswered question.
 */
export async function withQuestionAttention<
  T extends { id: string; state: string; attentionState: string; attentionReason: string | null },
>(rows: T[]): Promise<T[]> {
  const live = rows.filter((row) => row.state === "running" && row.attentionReason !== "killed");
  if (!live.length) return rows;
  const entries = await db
    .select()
    .from(transcript)
    .where(
      and(
        inArray(
          transcript.terminalId,
          live.map((row) => row.id),
        ),
        or(
          and(eq(transcript.kind, "tool_use"), eq(transcript.toolName, "request_user_input_async")),
          eq(transcript.role, "user"),
          and(eq(transcript.role, "system"), eq(transcript.source, "rewind")),
        ),
      ),
    )
    .orderBy(asc(transcript.seq));
  const byTerminal = new Map<string, LocalTranscriptEntry[]>();
  for (const entry of entries) {
    const group = byTerminal.get(entry.terminalId) ?? [];
    // Match the transcript API's legacy-turn classification: automated
    // notifications stored as "user" must not dismiss a person's questions.
    const automated =
      entry.role === "user" && entry.kind === "text" && !entry.source
        ? classifyTranscriptUserText(entry.text)
        : null;
    group.push({
      ...entry,
      ...(automated ? { role: "system", source: automated.source, text: automated.text } : {}),
      at: entry.at?.toISOString() ?? null,
    } as LocalTranscriptEntry);
    byTerminal.set(entry.terminalId, group);
  }
  return rows.map((row) =>
    pendingCodexQuestions(byTerminal.get(row.id) ?? []).length
      ? { ...row, attentionState: "needs_you", attentionReason: "question" }
      : row,
  );
}
