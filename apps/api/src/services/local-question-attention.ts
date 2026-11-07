import { and, asc, eq, inArray, like, or } from "drizzle-orm";
import { pendingCodexQuestions, type LocalTranscriptEntry } from "@optio/shared";
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
          and(
            eq(transcript.role, "user"),
            like(transcript.text, "%<send_user_message_question_reply>%"),
          ),
          and(eq(transcript.role, "system"), eq(transcript.source, "rewind")),
        ),
      ),
    )
    .orderBy(asc(transcript.seq));
  const byTerminal = new Map<string, LocalTranscriptEntry[]>();
  for (const entry of entries) {
    const group = byTerminal.get(entry.terminalId) ?? [];
    group.push({ ...entry, at: entry.at?.toISOString() ?? null } as LocalTranscriptEntry);
    byTerminal.set(entry.terminalId, group);
  }
  return rows.map((row) =>
    pendingCodexQuestions(byTerminal.get(row.id) ?? []).length
      ? { ...row, attentionState: "needs_you", attentionReason: "question" }
      : row,
  );
}
