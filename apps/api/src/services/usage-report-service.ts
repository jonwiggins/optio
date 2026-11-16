import { sql, type SQL } from "drizzle-orm";
import type { UsageMetrics } from "@optio/shared";
import { db } from "../db/client.js";
import { metrics, totals, type Aggregate } from "./usage-service.js";

/**
 * The deployment cost report: `usage_ledger` totals across every workspace,
 * grouped one way, for a range of whole UTC days. It reads the same ledger
 * and the same totals as Insights → Usage (`getUsage`); only the scope (the
 * whole deployment instead of one workspace) and the grouping differ. Who may
 * read it is the route's business (deployment admins only).
 */

export const REPORT_GROUPS = ["workspace", "person", "repo", "model", "agent", "month"] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

/** The longest range one report covers, in days (inclusive). */
export const MAX_REPORT_DAYS = 366;
/** More groups than this are cut off and the report says so. */
export const MAX_REPORT_ROWS = 5000;

export interface ReportRow extends UsageMetrics {
  /** The grouped value: a workspace or person id, repo URL, model, agent or `YYYY-MM`. */
  key: string | null;
  /** What to show for it. */
  name: string;
}

export interface UsageReport {
  from: string;
  to: string;
  groupBy: ReportGroup;
  totals: UsageMetrics;
  rows: ReportRow[];
  truncated: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `s` is a real calendar date written `YYYY-MM-DD`. */
export function isIsoDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The report's range: `from` and `to` are inclusive UTC days. Defaults to the
 * current UTC month up to today. Returns an error message for a range that is
 * backwards or longer than MAX_REPORT_DAYS.
 */
export function reportRange(
  query: { from?: string; to?: string },
  now = new Date(),
): { from: string; to: string; start: Date; end: Date } | { error: string } {
  const to = query.to ?? day(now);
  const from = query.from ?? `${to.slice(0, 7)}-01`;
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  if (start >= end) return { error: "`from` must be on or before `to`" };
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_REPORT_DAYS)
    return { error: `A report covers at most ${MAX_REPORT_DAYS} days` };
  return { from, to, start, end };
}

// Each grouping: the column grouped by, its key as text, and its display name.
// Fixed SQL only; nothing from the request is spliced in here.
const GROUPS: Record<ReportGroup, { by: SQL; key: SQL; name: SQL; order?: SQL }> = {
  workspace: {
    by: sql`workspace_id`,
    key: sql`workspace_id::text`,
    name: sql`CASE WHEN workspace_id IS NULL THEN 'No workspace'
      ELSE COALESCE((SELECT w.name FROM workspaces w WHERE w.id = l.workspace_id), 'Deleted workspace') END`,
  },
  person: {
    by: sql`owner_user_id`,
    key: sql`owner_user_id::text`,
    name: sql`CASE WHEN owner_user_id IS NULL THEN 'Organization work'
      ELSE COALESCE((SELECT u.display_name FROM users u WHERE u.id = l.owner_user_id), 'Former member') END`,
  },
  repo: { by: sql`repo_url`, key: sql`repo_url`, name: sql`COALESCE(repo_url, 'No repository')` },
  model: { by: sql`model`, key: sql`model`, name: sql`COALESCE(model, 'Not reported')` },
  agent: { by: sql`runtime`, key: sql`runtime`, name: sql`COALESCE(runtime, 'Not reported')` },
  month: {
    by: sql`to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM')`,
    key: sql`to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM')`,
    name: sql`to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM')`,
    order: sql`1 ASC`,
  },
};

export async function getUsageReport(query: {
  groupBy: ReportGroup;
  start: Date;
  end: Date;
  from: string;
  to: string;
  workspaceId?: string;
}): Promise<UsageReport> {
  const g = GROUPS[query.groupBy];
  const where = sql`occurred_at >= ${query.start.toISOString()}::timestamptz
    AND occurred_at < ${query.end.toISOString()}::timestamptz
    ${query.workspaceId ? sql`AND workspace_id = ${query.workspaceId}::uuid` : sql``}`;
  const order = g.order ?? sql`SUM(cost_usd) DESC NULLS LAST, tokens DESC, 1 ASC NULLS LAST`;
  const [all, rows] = await Promise.all([
    db.execute<Aggregate>(sql`SELECT ${totals} FROM usage_ledger l WHERE ${where}`),
    db.execute<Aggregate & { key: string | null; name: string }>(
      sql`SELECT ${g.key} AS key, ${g.name} AS name, ${totals} FROM usage_ledger l WHERE ${where}
        GROUP BY ${g.by} ORDER BY ${order} LIMIT ${MAX_REPORT_ROWS + 1}`,
    ),
  ]);
  return {
    from: query.from,
    to: query.to,
    groupBy: query.groupBy,
    totals: metrics(all[0]),
    rows: rows
      .slice(0, MAX_REPORT_ROWS)
      .map((r) => ({ key: r.key, name: String(r.name), ...metrics(r) })),
    truncated: rows.length > MAX_REPORT_ROWS,
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * One CSV cell. Text that a spreadsheet would read as a formula (it starts
 * with = + - @, a tab or a carriage return) gets a leading apostrophe; repo
 * URLs, model names and display names are user-controlled. Then RFC 4180
 * quoting.
 */
export function csvCell(value: string | number | null, text = true): string {
  if (value === null) return "";
  let s = String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

// [header, value, text]: only the text columns can carry user-controlled
// strings; the rest are counts and decimal amounts from the ledger.
const COLUMNS: Array<[string, (r: ReportRow) => string | number | null, boolean?]> = [
  ["key", (r) => r.key, true],
  ["name", (r) => r.name, true],
  ["runs", (r) => r.runs],
  ["completed_runs", (r) => r.completedRuns],
  ["tokens", (r) => r.tokens],
  ["input_tokens", (r) => r.inputTokens],
  ["output_tokens", (r) => r.outputTokens],
  ["cached_input_tokens", (r) => r.cachedTokens],
  ["cost_usd", (r) => r.costUsd],
  ["reported_cost_usd", (r) => r.reportedCostUsd],
  ["estimated_cost_usd", (r) => r.estimatedCostUsd],
  ["unpriced_runs", (r) => r.unpricedRuns],
];

/** The report as CSV: a header row, then one row per group (CRLF line ends). */
export function reportToCsv(report: UsageReport): string {
  const lines = [
    COLUMNS.map(([h]) => h).join(","),
    ...report.rows.map((r) => COLUMNS.map(([, get, text]) => csvCell(get(r), !!text)).join(",")),
  ];
  return lines.join("\r\n") + "\r\n";
}
