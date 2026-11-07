/**
 * Reading the audit trail (docs/audit.md): the Audit page's list, its CSV
 * and JSON-lines export, and who may read what.
 *
 * Who reads: a workspace admin reads their workspace's entries; a
 * deployment admin reads every workspace's, plus the deployment-wide ones
 * (no workspace: refused sign-ins, sign-in settings, deployment admins).
 * Members and viewers read nothing here (their Activity feed leaves the
 * admin-only actions out). The routes decide the scope (`routes/audit.ts`);
 * this module only applies it.
 *
 * Filters: a person (what they did, and what was done to them: a
 * membership change naming them), actions (a name or
 * a prefix of whole segments, several at once), a time range and the outcome.
 */
import { and, desc, eq, gte, lte, or, sql, type SQL } from "drizzle-orm";
import { auditActionLabel } from "@optio/shared";
import { db } from "../db/client.js";
import { optioActions, users, workspaces } from "../db/schema.js";
import { ACTION_PARAM_ALLOWLIST } from "./optio-action-service.js";
import { actionMatchesSql } from "./audit.js";

/** Whose entries a reader sees. */
export type AuditScope = { kind: "workspace"; workspaceId: string } | { kind: "all" };

export interface AuditFilters {
  /** A deployment admin's pick of one workspace (ignored for a workspace scope). */
  workspaceId?: string;
  userId?: string;
  teamId?: string;
  /** Action names or prefixes (`team`, `auth.sign_in`); any of them matches. */
  actions?: string[];
  from?: Date;
  to?: Date;
  outcome?: "success" | "failure";
}

/** One entry as the Audit page and the export show it. */
export interface AuditItem {
  id: string;
  time: string;
  workspaceId: string | null;
  workspaceName: string | null;
  actor: { id: string; email: string | null; name: string | null } | null;
  action: string;
  label: string;
  success: boolean;
  clientIp: string | null;
  details: Record<string, unknown>;
}

/** The WHERE for a scope and filters (exported for tests). */
export function auditWhere(scope: AuditScope, f: AuditFilters = {}): SQL | undefined {
  const conds: SQL[] = [];
  if (scope.kind === "workspace") conds.push(eq(optioActions.workspaceId, scope.workspaceId));
  else if (f.workspaceId) conds.push(eq(optioActions.workspaceId, f.workspaceId));
  if (f.userId) {
    conds.push(
      or(
        eq(optioActions.userId, f.userId),
        sql`${optioActions.params}->>'targetUserId' = ${f.userId}`,
        sql`${optioActions.params}->>'confirmedBy' = ${f.userId}`,
      )!,
    );
  }
  const actions = (f.actions ?? []).map((a) => a.trim().replace(/\.+$/, "")).filter(Boolean);
  if (actions.length > 0) {
    conds.push(or(...actions.map((a) => actionMatchesSql(sql`${optioActions.action}`, a)))!);
  }
  if (f.from) conds.push(gte(optioActions.createdAt, f.from));
  if (f.to) conds.push(lte(optioActions.createdAt, f.to));
  if (f.outcome) conds.push(eq(optioActions.success, f.outcome === "success"));
  return conds.length > 0 ? and(...conds) : undefined;
}

/** Stored params reduced to the allowlist (rows written before write-time filtering). */
function detailsOf(
  params: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (ACTION_PARAM_ALLOWLIST.has(k) && v !== undefined) out[k] = v;
  }
  // Upstream rows often name what they made only in `result` (`{ id }`).
  if (out.id === undefined && typeof result?.id === "string") out.id = result.id;
  return out;
}

const columns = {
  id: optioActions.id,
  createdAt: optioActions.createdAt,
  createdAtText: sql<string>`${optioActions.createdAt}::text`,
  workspaceId: optioActions.workspaceId,
  workspaceName: workspaces.name,
  userId: optioActions.userId,
  userEmail: users.email,
  userName: users.displayName,
  action: optioActions.action,
  success: optioActions.success,
  clientIp: optioActions.clientIp,
  params: optioActions.params,
  result: optioActions.result,
};

type Row = {
  id: string;
  createdAt: Date;
  createdAtText: string;
  workspaceId: string | null;
  workspaceName: string | null;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  action: string;
  success: boolean;
  clientIp: string | null;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
};

function toItem(r: Row): AuditItem {
  return {
    id: r.id,
    time: new Date(r.createdAt).toISOString(),
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName ?? null,
    actor: r.userId ? { id: r.userId, email: r.userEmail ?? null, name: r.userName ?? null } : null,
    action: r.action,
    label: auditActionLabel(r.action),
    success: r.success,
    clientIp: r.clientIp ?? null,
    details: detailsOf(r.params, r.result),
  };
}

function baseQuery() {
  return db
    .select(columns)
    .from(optioActions)
    .leftJoin(users, eq(optioActions.userId, users.id))
    .leftJoin(workspaces, eq(optioActions.workspaceId, workspaces.id));
}

/** A page of entries, newest first, and how many match. */
export async function listAudit(
  scope: AuditScope,
  filters: AuditFilters,
  page: { limit: number; offset: number },
): Promise<{ items: AuditItem[]; total: number }> {
  const where = auditWhere(scope, filters);
  const [rows, counted] = await Promise.all([
    baseQuery()
      .where(where)
      .orderBy(desc(optioActions.createdAt), desc(optioActions.id))
      .limit(page.limit)
      .offset(page.offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(optioActions)
      .where(where),
  ]);
  return { items: (rows as Row[]).map(toItem), total: counted[0]?.n ?? 0 };
}

/**
 * Every matching entry, newest first, read in batches (keyset on the exact
 * stored time and the id, so an export of any size holds one batch in memory
 * and never skips or repeats a row that shares its millisecond).
 */
export async function* auditEntries(
  scope: AuditScope,
  filters: AuditFilters,
  batch = 1000,
): AsyncGenerator<AuditItem> {
  const where = auditWhere(scope, filters);
  let cursor: { at: string; id: string } | null = null;
  for (;;) {
    const page = cursor
      ? sql`(${optioActions.createdAt}, ${optioActions.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
      : undefined;
    const rows = (await baseQuery()
      .where(page ? (where ? and(where, page) : page) : where)
      .orderBy(desc(optioActions.createdAt), desc(optioActions.id))
      .limit(batch)) as Row[];
    for (const r of rows) yield toItem(r);
    if (rows.length < batch) return;
    const last = rows[rows.length - 1];
    cursor = { at: last.createdAtText, id: last.id };
  }
}

// ── Export formats ─────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  "time",
  "workspace_id",
  "workspace",
  "actor_id",
  "actor_email",
  "actor_name",
  "action",
  "label",
  "success",
  "client_ip",
  "details",
] as const;

/**
 * One CSV field: quoted when it holds a comma, quote or line break, and a
 * leading `=`, `+`, `-`, `@`, tab or carriage return defused with `'` so a
 * spreadsheet never runs a name someone chose as a formula.
 */
export function csvField(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvHeader(): string {
  return `${CSV_COLUMNS.join(",")}\r\n`;
}

export function csvRow(i: AuditItem): string {
  return (
    [
      i.time,
      i.workspaceId,
      i.workspaceName,
      i.actor?.id,
      i.actor?.email,
      i.actor?.name,
      i.action,
      i.label,
      i.success,
      i.clientIp,
      Object.keys(i.details).length ? JSON.stringify(i.details) : "",
    ]
      .map(csvField)
      .join(",") + "\r\n"
  );
}

export function jsonLine(i: AuditItem): string {
  return `${JSON.stringify(i)}\n`;
}
