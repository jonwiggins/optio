import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessionChatTurns } from "../db/schema.js";

export async function claimSessionTurn(sessionId: string, requestId: string, prompt: string) {
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  const [turn] = await db
    .insert(sessionChatTurns)
    .values({ sessionId, requestId, promptHash, state: "running" })
    .onConflictDoNothing()
    .returning();
  if (turn) return { accepted: true as const, turn };
  const [existing] = await db
    .select()
    .from(sessionChatTurns)
    .where(
      and(eq(sessionChatTurns.sessionId, sessionId), eq(sessionChatTurns.requestId, requestId)),
    );
  return {
    accepted: false as const,
    reason: existing
      ? existing.promptHash !== promptHash
        ? "Request ID already belongs to a different prompt"
        : `This prompt was already accepted (${existing.state}); it will not be replayed`
      : "Another turn is running in this session",
  };
}

export async function finishSessionTurn(id: string, completed: boolean) {
  await db
    .update(sessionChatTurns)
    .set({ state: completed ? "completed" : "interrupted", finishedAt: new Date() })
    .where(and(eq(sessionChatTurns.id, id), eq(sessionChatTurns.state, "running")));
}

/** Single API replica, before accepting requests. Never requeue uncertain work. */
export async function recoverSessionTurns() {
  await db
    .update(sessionChatTurns)
    .set({ state: "interrupted", finishedAt: new Date() })
    .where(eq(sessionChatTurns.state, "running"));
}

export async function latestSessionTurn(sessionId: string) {
  const [turn] = await db
    .select()
    .from(sessionChatTurns)
    .where(eq(sessionChatTurns.sessionId, sessionId))
    .orderBy(desc(sessionChatTurns.startedAt))
    .limit(1);
  return turn ?? null;
}

type Listener = (frame: Record<string, unknown>) => void;
const listeners = new Map<string, Set<Listener>>();
const interrupts = new Map<string, () => void>();
export function subscribeSessionChat(id: string, listener: Listener) {
  const set = listeners.get(id) ?? new Set();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(id);
  };
}
export function broadcastSessionChat(id: string, frame: Record<string, unknown>) {
  for (const listener of listeners.get(id) ?? []) listener(frame);
}
export function setSessionInterrupt(id: string, interrupt: (() => void) | null) {
  if (interrupt) interrupts.set(id, interrupt);
  else interrupts.delete(id);
}
export function interruptSessionChat(id: string) {
  interrupts.get(id)?.();
}
