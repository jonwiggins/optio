import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import type { UsageBudget, UsageMetrics, UsageQuery, UsageResponse } from "@optio/shared";
import type { Actor } from "./ownership.js";

const PAGE_SIZE = 25;
export type Aggregate = Record<string, string | number | null>;
const runKey = sql`source_kind || ':' || source_id::text`;
/** The ledger totals every usage view reports (also the deployment cost report). */
export const totals = sql`
  SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS tokens,
  SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cached_tokens, SUM(cost_usd)::text AS cost_usd,
  SUM(cost_usd) FILTER (WHERE cost_basis='reported')::text AS reported_cost_usd,
  SUM(cost_usd) FILTER (WHERE cost_basis='estimated')::text AS estimated_cost_usd,
  COUNT(DISTINCT ${runKey}) AS runs,
  COUNT(DISTINCT ${runKey}) FILTER (WHERE outcome='completed') AS completed_runs,
  COUNT(DISTINCT ${runKey}) - COUNT(DISTINCT ${runKey}) FILTER (WHERE cost_usd IS NOT NULL) AS unpriced_runs,
  COUNT(DISTINCT ${runKey}) - COUNT(DISTINCT ${runKey}) FILTER (WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL) AS unmeasured_runs,
  COUNT(DISTINCT ${runKey}) FILTER (WHERE historical) AS historical_runs,
  COALESCE(SUM(cost_usd) FILTER (WHERE retry),0)::text AS retry_cost_usd`;

export function metrics(row: Aggregate | undefined): UsageMetrics {
  const n = (key: string) => Number(row?.[key] ?? 0);
  const amount = (key: string) => (row?.[key] == null ? null : String(row[key]));
  return {
    tokens: n("tokens"),
    inputTokens: n("input_tokens"),
    outputTokens: n("output_tokens"),
    cachedTokens: n("cached_tokens"),
    costUsd: amount("cost_usd"),
    reportedCostUsd: amount("reported_cost_usd"),
    estimatedCostUsd: amount("estimated_cost_usd"),
    runs: n("runs"),
    completedRuns: n("completed_runs"),
    unpricedRuns: n("unpriced_runs"),
    unmeasuredRuns: n("unmeasured_runs"),
    historicalRuns: n("historical_runs"),
    retryCostUsd: amount("retry_cost_usd") ?? "0",
  };
}
export const usageScope = (workspaceId: string | null) =>
  workspaceId ? sql`workspace_id = ${workspaceId}::uuid` : sql`workspace_id IS NULL`;

export async function listUsageBudgets(workspaceId: string | null): Promise<UsageBudget[]> {
  if (!workspaceId) return [];
  const rows = await db.execute<{
    id: string;
    name: string;
    subject_kind: UsageBudget["subjectKind"];
    subject_id: string | null;
    token_limit: string | null;
    cost_limit: string | null;
    action: UsageBudget["action"];
    enabled: boolean;
    used_tokens: string;
    used_cost: string;
  }>(sql`SELECT b.*, COALESCE(u.tokens,0)::text AS used_tokens, COALESCE(u.cost,0)::text AS used_cost
    FROM usage_budgets b LEFT JOIN LATERAL (
      SELECT SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS tokens, SUM(cost_usd) AS cost
      FROM usage_ledger u WHERE u.workspace_id=b.workspace_id
      AND u.occurred_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND (b.subject_kind='organization' OR (u.subject_kind=b.subject_kind AND u.subject_id=b.subject_id))
    ) u ON true WHERE b.workspace_id=${workspaceId}::uuid ORDER BY b.created_at`);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    tokenLimit: r.token_limit == null ? null : Number(r.token_limit),
    costLimit: r.cost_limit,
    action: r.action,
    enabled: r.enabled,
    usedTokens: Number(r.used_tokens),
    usedCostUsd: r.used_cost,
    fraction: Math.max(
      r.token_limit ? Number(r.used_tokens) / Number(r.token_limit) : 0,
      r.cost_limit ? Number(r.used_cost) / Number(r.cost_limit) : 0,
    ),
  }));
}

export async function getUsage(query: UsageQuery, actor: Actor): Promise<UsageResponse> {
  const days = query.days ?? 30;
  const end = new Date();
  const start = new Date(end);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const prior = new Date(start.getTime() - (end.getTime() - start.getTime()));
  const page = query.page ?? 0;
  const scope = sql`${usageScope(actor.workspaceId)}
    ${query.subjectId ? sql`AND subject_id=${query.subjectId}::uuid` : sql``}
    ${query.kind && query.kind !== "all" ? sql`AND subject_kind=${query.kind}` : sql``}
    ${query.model ? sql`AND model=${query.model}` : sql``}
    ${query.repoUrl ? sql`AND repo_url=${query.repoUrl}` : sql``}`;
  const current = sql`${scope} AND occurred_at >= ${start.toISOString()}::timestamptz AND occurred_at <= ${end.toISOString()}::timestamptz`;
  const previous = sql`${scope} AND occurred_at >= ${prior.toISOString()}::timestamptz AND occurred_at < ${start.toISOString()}::timestamptz`;
  const sort =
    query.sort === "cost"
      ? sql`SUM(cost_usd)`
      : query.sort === "runs"
        ? sql`COUNT(DISTINCT ${runKey})`
        : sql`SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0))`;
  const name = sql`CASE WHEN subject_kind='person' THEN COALESCE((SELECT display_name FROM users WHERE id=subject_id),'Former member') ELSE (array_agg(subject_name ORDER BY occurred_at DESC,id DESC))[1] END`;
  const search = query.q ? sql`HAVING ${name} ILIKE ${`%${query.q}%`}` : sql``;
  const [currentTotals, priorTotals, daily, entries, modelRows, budgets] = await Promise.all([
    db.execute<Aggregate>(sql`SELECT ${totals} FROM usage_ledger WHERE ${current}`),
    db.execute<Aggregate>(sql`SELECT ${totals} FROM usage_ledger WHERE ${previous}`),
    db.execute<{ date: string; tokens: string; cost_usd: string | null }>(
      sql`SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS tokens, SUM(cost_usd)::text AS cost_usd FROM usage_ledger WHERE ${current} GROUP BY 1 ORDER BY 1`,
    ),
    db.execute<
      Aggregate & {
        subject_id: string;
        subject_kind: "person" | "work";
        name: string;
        avatar_url: string | null;
        entry_count: string;
      }
    >(
      sql`SELECT subject_id, subject_kind, ${name} AS name, CASE WHEN subject_kind='person' THEN (SELECT avatar_url FROM users WHERE id=subject_id) END AS avatar_url, COUNT(*) OVER() AS entry_count, ${totals} FROM usage_ledger WHERE ${current} GROUP BY subject_kind,subject_id ${search} ORDER BY ${sort} DESC NULLS LAST,subject_kind,subject_id LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`,
    ),
    db.execute<{ model: string; tokens: string; cost_usd: string | null; runs: string }>(
      sql`SELECT COALESCE(model,'Not reported') AS model, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS tokens,SUM(cost_usd)::text AS cost_usd, COUNT(DISTINCT ${runKey}) AS runs FROM usage_ledger WHERE ${current} GROUP BY model ORDER BY tokens DESC LIMIT 30`,
    ),
    listUsageBudgets(actor.workspaceId),
  ]);
  const ids = entries.map((r) => r.subject_id);
  const history = ids.length
    ? await db.execute<{ subject_id: string; date: string; tokens: string; prior: boolean }>(
        sql`SELECT subject_id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS date, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS tokens, occurred_at < ${start.toISOString()}::timestamptz AS prior FROM usage_ledger WHERE ${scope} AND occurred_at >= ${prior.toISOString()}::timestamptz AND occurred_at <= ${end.toISOString()}::timestamptz AND subject_id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`,`,
        )}) GROUP BY subject_id,date,prior`,
      )
    : [];
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10),
  );
  const canInspect =
    !!query.subjectId &&
    (actor.isAdmin || query.kind === "work" || query.subjectId === actor.userId);
  const activity = canInspect
    ? await db.execute<{
        id: string;
        name: string;
        href: string;
        tokens: string;
        cost_usd: string | null;
        model: string | null;
        last_used: string;
      }>(
        sql`SELECT source_id AS id,(array_agg(work_name ORDER BY occurred_at DESC))[1] AS name,(array_agg(href ORDER BY occurred_at DESC))[1] AS href,SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS tokens,SUM(cost_usd)::text AS cost_usd,(array_agg(model ORDER BY occurred_at DESC))[1] AS model,MAX(occurred_at)::text AS last_used FROM usage_ledger WHERE ${current} AND ${actor.isAdmin ? sql`true` : sql`(owner_user_id IS NULL OR owner_user_id=${actor.userId}::uuid)`} GROUP BY source_kind,source_id ORDER BY MAX(occurred_at) DESC LIMIT 50`,
      )
    : [];
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    summary: metrics(currentTotals[0]),
    previous: metrics(priorTotals[0]),
    daily: dates.map((date) => {
      const r = daily.find((x) => x.date === date);
      return { date, tokens: Number(r?.tokens ?? 0), costUsd: r?.cost_usd ?? null };
    }),
    leaderboard: entries.map((r, i) => {
      const rows = history.filter((h) => h.subject_id === r.subject_id);
      const previousTokens = rows.filter((h) => h.prior).reduce((n, h) => n + Number(h.tokens), 0);
      const m = metrics(r);
      return {
        ...m,
        id: r.subject_id,
        kind: r.subject_kind,
        name: r.name,
        avatarUrl: r.avatar_url,
        rank: page * PAGE_SIZE + i + 1,
        changePercent: previousTokens ? (100 * (m.tokens - previousTokens)) / previousTokens : null,
        trend: dates.map((d) => Number(rows.find((h) => !h.prior && h.date === d)?.tokens ?? 0)),
      };
    }),
    totalEntries: Number(entries[0]?.entry_count ?? 0),
    page,
    pageSize: PAGE_SIZE,
    models: modelRows.map((r) => ({
      model: r.model,
      tokens: Number(r.tokens),
      costUsd: r.cost_usd,
      runs: Number(r.runs),
    })),
    budgets,
    canManageBudgets: actor.isAdmin && !!actor.workspaceId,
    canInspect,
    activity: activity.map((r) => ({
      id: r.id,
      name: r.name,
      href: r.href,
      tokens: Number(r.tokens),
      costUsd: r.cost_usd,
      model: r.model,
      lastUsed: new Date(r.last_used).toISOString(),
    })),
  };
}
