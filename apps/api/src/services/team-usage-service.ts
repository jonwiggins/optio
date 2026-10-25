import { and, asc, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { gatewayIssuedKeys, teams } from "../db/schema.js";
import { defaultGateway } from "./model-gateway-service.js";
import { gatewayAdminOf, teamBudgetOf, type TeamBudgetView } from "./gateway-keys.js";
import type { Actor } from "./ownership.js";

/**
 * Usage per team (docs/usage.md "Teams"): the Usage page's team breakdown.
 * The ledger charges a team's work to the person who made it; here the same
 * rows are summed by the team that owns the work (the run's or the agent's
 * `owner_team_id`), so a team sees what its work cost whoever started it.
 *
 * Who sees which team: a workspace admin every team of the workspace, anyone
 * else the teams they are in — a team's work is its members' to see
 * (services/work-visibility.ts), so its totals are too. Each team also shows
 * its gateway budget when Optio made its key (read live from the gateway).
 */

export interface TeamUsageRow {
  teamId: string;
  name: string;
  tokens: number;
  /** USD; null when no run of it was priced. */
  costUsd: string | null;
  runs: number;
  /** The team's gateway budget, when Optio made the team's key. */
  gatewayBudget: TeamBudgetView | null;
}

export interface TeamUsage {
  start: string;
  end: string;
  teams: TeamUsageRow[];
}

/** The team that owns a ledger row's work, as usage-service.ts reads it. */
const workTeam = sql`(CASE l.source_kind
  WHEN 'tasks' THEN (SELECT w.owner_team_id FROM tasks w WHERE w.id = l.source_id)
  WHEN 'persistent_agent_turns' THEN (SELECT a.owner_team_id FROM persistent_agents a WHERE a.id = l.work_id)
END)`;

/** `GET /api/usage/teams?days=`: tokens, cost and runs per team over the last `days` days. */
export async function teamUsage(actor: Actor, days = 30): Promise<TeamUsage> {
  const end = new Date();
  const start = new Date(end);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const empty = { start: start.toISOString(), end: end.toISOString(), teams: [] };
  if (!actor.workspaceId) return empty;

  const visible = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(
      actor.isAdmin
        ? eq(teams.workspaceId, actor.workspaceId)
        : (actor.teamIds ?? []).length
          ? and(eq(teams.workspaceId, actor.workspaceId), inArray(teams.id, actor.teamIds ?? []))
          : sql`false`,
    )
    .orderBy(asc(teams.name));
  if (!visible.length) return empty;

  const ids = visible.map((t) => t.id);
  const totals = await db.execute<{
    team_id: string;
    tokens: string;
    cost_usd: string | null;
    runs: string;
  }>(sql`
    SELECT team_id,
      SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS tokens,
      SUM(cost_usd)::text AS cost_usd,
      COUNT(DISTINCT source_kind || ':' || source_id::text) AS runs
    FROM (
      SELECT ${workTeam} AS team_id, l.input_tokens, l.output_tokens, l.cost_usd, l.source_kind, l.source_id
      FROM usage_ledger l
      WHERE l.workspace_id = ${actor.workspaceId}::uuid
        AND l.occurred_at >= ${start.toISOString()}::timestamptz
        AND l.occurred_at <= ${end.toISOString()}::timestamptz
    ) x
    WHERE team_id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`,`,
    )})
    GROUP BY team_id`);
  const byTeam = new Map(totals.map((r) => [r.team_id, r]));

  // The gateway budgets of teams whose key Optio made, read live from the gateway.
  const gateway = await defaultGateway(actor.workspaceId);
  const keys = gateway
    ? await db
        .select()
        .from(gatewayIssuedKeys)
        .where(
          and(
            eq(gatewayIssuedKeys.providerId, gateway.id),
            eq(gatewayIssuedKeys.kind, "team"),
            eq(gatewayIssuedKeys.status, "active"),
            inArray(gatewayIssuedKeys.teamId, ids),
          ),
        )
    : [];
  const admin = gateway && keys.length ? gatewayAdminOf(gateway) : null;
  const budgets = new Map(
    await Promise.all(
      keys.map(async (k) => [k.teamId as string, await teamBudgetOf(k, admin)] as const),
    ),
  );

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    teams: visible
      .map((t) => {
        const r = byTeam.get(t.id);
        return {
          teamId: t.id,
          name: t.name,
          tokens: Number(r?.tokens ?? 0),
          costUsd: r?.cost_usd ?? null,
          runs: Number(r?.runs ?? 0),
          gatewayBudget: budgets.get(t.id) ?? null,
        };
      })
      .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)),
  };
}
