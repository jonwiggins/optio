/**
 * A copy of every audit entry for the deployment's SIEM (docs/audit.md): with
 * `OPTIO_AUDIT_STDOUT=json` (Helm `audit.stdout: json`), each row the action
 * log writes (`logAction`) is also printed to stdout as one JSON line, which
 * the cluster's log collector ships like any container log. The line is
 * marked `"type":"optio.audit"` so a collector can route it apart from the
 * API's own log lines.
 *
 *   {"type":"optio.audit","version":1,"time":"2026-10-24T09:12:03.120Z","id":"…",
 *    "action":"auth.sign_in","success":true,"workspaceId":"…",
 *    "actor":{"id":"…","email":"carol@example.test","name":"Carol"},
 *    "clientIp":"10.20.30.40","details":{"provider":"ldap","via":"cli"}}
 *
 * Off by default. Printing never fails the action: a lookup error prints the
 * line without the actor's email and name.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";

/** What `logAction` stored (the columns this line reads). */
export interface AuditRowLike {
  id: string;
  workspaceId?: string | null;
  userId?: string | null;
  action: string;
  params?: Record<string, unknown> | null;
  success: boolean;
  clientIp?: string | null;
  createdAt?: Date | string | null;
}

export interface AuditLine {
  type: "optio.audit";
  version: 1;
  time: string;
  id: string;
  action: string;
  success: boolean;
  workspaceId: string | null;
  actor: { id: string; email: string | null; name: string | null } | null;
  clientIp: string | null;
  details: Record<string, unknown>;
}

/** Whether audit entries are copied to stdout (`OPTIO_AUDIT_STDOUT=json`). */
export function auditStdoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPTIO_AUDIT_STDOUT ?? "").trim().toLowerCase() === "json";
}

/** The line for one row (pure; the actor's email and name come from the caller). */
export function auditLine(
  row: AuditRowLike,
  actor?: { email: string | null; name: string | null } | null,
): AuditLine {
  const created = row.createdAt ? new Date(row.createdAt) : new Date();
  return {
    type: "optio.audit",
    version: 1,
    time: Number.isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
    id: row.id,
    action: row.action,
    success: row.success,
    workspaceId: row.workspaceId ?? null,
    actor: row.userId
      ? { id: row.userId, email: actor?.email ?? null, name: actor?.name ?? null }
      : null,
    clientIp: row.clientIp ?? null,
    details: row.params ?? {},
  };
}

// People rarely change their email: a short cache keeps a burst of entries
// (a bulk action, a sign-in storm) from querying users once per line.
const ACTOR_TTL_MS = 60_000;
const ACTOR_CACHE_MAX = 1000;
const actorCache = new Map<
  string,
  { at: number; value: { email: string | null; name: string | null } }
>();

async function actorOf(userId: string): Promise<{ email: string | null; name: string | null }> {
  const hit = actorCache.get(userId);
  if (hit && Date.now() - hit.at < ACTOR_TTL_MS) return hit.value;
  const [row] = await db
    .select({ email: users.email, name: users.displayName })
    .from(users)
    .where(eq(users.id, userId));
  const value = { email: row?.email ?? null, name: row?.name ?? null };
  if (actorCache.size >= ACTOR_CACHE_MAX) actorCache.clear();
  actorCache.set(userId, { at: Date.now(), value });
  return value;
}

/** Forget cached actors (tests). */
export function resetAuditStdoutCache(): void {
  actorCache.clear();
}

let write: (line: string) => void = (line) => {
  process.stdout.write(line);
};

/** Swap the writer (tests). Returns the previous one. */
export function setAuditStdoutWriterForTests(fn: (line: string) => void): (line: string) => void {
  const previous = write;
  write = fn;
  return previous;
}

/**
 * Print `row` as one JSON line when `OPTIO_AUDIT_STDOUT=json`. Returns the
 * printing's promise (resolved, never rejected) so tests can wait for it;
 * `logAction` doesn't.
 */
export function emitAuditLine(row: AuditRowLike | null | undefined): Promise<void> {
  if (!row || !auditStdoutEnabled()) return Promise.resolve();
  const actor = row.userId ? actorOf(row.userId).catch(() => null) : Promise.resolve(null);
  return actor.then((who) => write(JSON.stringify(auditLine(row, who)) + "\n")).catch(() => {});
}
