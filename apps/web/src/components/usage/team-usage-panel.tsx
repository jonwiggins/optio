"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatTokens, formatUsd } from "@optio/shared";
import { Panel } from "@/components/ui/panel";
import { gatewayKeysApi, type TeamUsage } from "@/lib/gateway-keys-api";
import { BudgetMeter } from "@/components/teams/team-gateway-key";

/**
 * The Usage page's team breakdown (docs/usage.md "Teams"; fork): tokens,
 * cost and runs of each team's work over the period — team-owned work is
 * charged to its team, whoever started it — and the team's gateway budget
 * when Optio made its key. A workspace admin sees every team, anyone else
 * the teams they are in (`GET /api/usage/teams`). Nothing shows when the
 * viewer has no team.
 */
export function TeamUsagePanel({ days }: { days: number }) {
  const [usage, setUsage] = useState<TeamUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    gatewayKeysApi
      .getTeamUsage(days)
      .then((u) => active && setUsage(u))
      .catch((err) => active && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      active = false;
    };
  }, [days]);

  if (error) return null;
  if (!usage || usage.teams.length === 0) return null;
  const top = Math.max(1, ...usage.teams.map((t) => t.tokens));

  return (
    <Panel title="Teams" actions={<span>Team work, whoever started it</span>}>
      <div className="divide-y divide-border/40" data-testid="team-usage">
        {usage.teams.map((t) => (
          <div key={t.teamId} className="p-4 space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <Link href={`/teams/${t.teamId}`} className="text-sm hover:text-primary truncate">
                {t.name}
              </Link>
              <span className="text-xs text-text-muted tabular-nums">
                {formatTokens(t.tokens)} tokens ·{" "}
                {t.costUsd === null ? "cost not reported" : formatUsd(Number(t.costUsd))} ·{" "}
                {t.runs.toLocaleString()} run{t.runs === 1 ? "" : "s"}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
              <div
                className="h-full rounded-full bg-primary/60"
                style={{ width: `${(t.tokens / top) * 100}%` }}
              />
            </div>
            {t.gatewayBudget && (
              <div className="pt-1">
                <p className="text-[11px] text-text-muted mb-1">Gateway budget</p>
                <BudgetMeter budget={t.gatewayBudget} />
              </div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
