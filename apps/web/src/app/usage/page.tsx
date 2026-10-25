"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  BarChart3,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Info,
  Search,
  Users,
  X,
} from "lucide-react";
import {
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { UsageBudget, UsageEntry, UsageQuery, UsageResponse } from "@optio/shared";
import { formatTokens, formatUsd } from "@optio/shared";
import { api } from "@/lib/api-client";
import { usePageTitle } from "@/hooks/use-page-title";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import { StatTile } from "@/components/ui/stat-tile";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { BudgetDialog } from "@/components/usage/budget-dialog";
import { costBasisNote } from "@/components/usage/cost-basis";
import { TeamUsagePanel } from "@/components/usage/team-usage-panel"; // usage per team

const money = (cost: string | null) => (cost === null ? "Not reported" : formatUsd(Number(cost)));

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <svg viewBox="0 0 100 28" className="w-24 h-7 text-primary" aria-hidden="true">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        points={values
          .map((v, i) => `${(i * 100) / Math.max(1, values.length - 1)},${26 - (v / max) * 24}`)
          .join(" ")}
      />
    </svg>
  );
}
export default function UsagePage() {
  usePageTitle("Usage");
  const [query, setQuery] = useState<UsageQuery>({
    days: 30,
    kind: "all",
    sort: "tokens",
    page: 0,
  });
  const [selected, setSelected] = useState<UsageEntry | null>(null);
  const [data, setData] = useState<UsageResponse | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  const [budget, setBudget] = useState<UsageBudget | true | null>(null);
  const [budgetSubject, setBudgetSubject] = useState<UsageEntry | null>(null);
  const [chart, setChart] = useState<"tokens" | "cost">("tokens");
  const [repos, setRepos] = useState<Array<{ repoUrl: string; fullName?: string }>>([]);
  function filter(next: Partial<UsageQuery>) {
    setQuery((q) => ({ ...q, ...next, page: 0 }));
  }
  useEffect(() => {
    api
      .listRepos()
      .then((r) => setRepos(r.repos))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const timeout = setTimeout(
      () => {
        api
          .getUsageAnalytics({
            ...query,
            ...(selected ? { subjectId: selected.id, kind: selected.kind } : {}),
          })
          .then((r) => {
            if (active) setData(r);
          })
          .catch((e) => {
            if (active) setError(e.message);
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query.q ? 200 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [query, selected, version]);
  const s = data?.summary;
  return (
    <div className="page-column py-6 space-y-6">
      <PageHeader
        title="Usage"
        icon={BarChart3}
        description="Understand how your organization uses AI, across people and shared work."
        actions={
          <>
            <Link href="/work/deliveries" className="text-xs text-text-muted hover:text-primary">
              Trigger history →
            </Link>
            <Segmented
              aria-label="Period"
              surface="card"
              value={String(query.days)}
              onChange={(v) => filter({ days: Number(v) })}
              options={[7, 30, 90].map((d) => ({ value: String(d), label: `${d} days` }))}
            />
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <select
          aria-label="Repository"
          value={query.repoUrl ?? ""}
          onChange={(e) => filter({ repoUrl: e.target.value || undefined })}
          className={inputClass({ className: "w-auto max-w-full" })}
        >
          <option value="">All repositories</option>
          {repos.map((r) => (
            <option key={r.repoUrl} value={r.repoUrl}>
              {r.fullName ?? r.repoUrl.split("/").slice(-2).join("/")}
            </option>
          ))}
        </select>
        {selected && (
          <button
            onClick={() => {
              setSelected(null);
              filter({ page: 0 });
            }}
            className="flex items-center gap-2 text-sm rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
          >
            {selected.name}
            <X className="w-3 h-3" />
            <span className="sr-only">Clear selection</span>
          </button>
        )}
        {query.model && (
          <button
            onClick={() => filter({ model: undefined })}
            className="flex items-center gap-2 text-sm rounded-lg border border-primary/30 px-3 py-2"
          >
            {query.model}
            <X className="w-3 h-3" />
            <span className="sr-only">Clear model</span>
          </button>
        )}
        <span className="ml-auto text-xs text-text-muted" role="status">
          {loading ? "Updating…" : "Recorded usage · UTC"}
        </span>
      </div>
      {error && (
        <div role="alert" className="border border-error/30 rounded-xl p-4 text-sm text-error">
          {error}{" "}
          <Button size="sm" variant="ghost" onClick={() => setVersion((v) => v + 1)}>
            Retry
          </Button>
        </div>
      )}
      {!data && !error && (
        <div aria-label="Loading usage" className="h-80 skeleton-shimmer rounded-xl" />
      )}
      {data && s && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile
              label="Total tokens"
              icon={Activity}
              value={
                <>
                  {formatTokens(s.tokens)}
                  <div className="text-xs font-normal text-text-muted mt-1">
                    {formatTokens(s.inputTokens)} input · {formatTokens(s.outputTokens)} output
                  </div>
                </>
              }
            />
            <StatTile
              label="Recorded cost"
              icon={DollarSign}
              value={
                <>
                  {money(s.costUsd)}
                  <div className="text-xs font-normal text-text-muted mt-1">{costBasisNote(s)}</div>
                </>
              }
            />
            <StatTile
              label="Runs"
              icon={CheckCircle2}
              value={
                <>
                  {s.runs.toLocaleString()}
                  <div className="text-xs font-normal text-text-muted mt-1">
                    {s.completedRuns.toLocaleString()} completed in period
                  </div>
                </>
              }
            />
            <StatTile
              label="Cached input"
              icon={BarChart3}
              value={
                <>
                  {formatTokens(s.cachedTokens)}
                  <div className="text-xs font-normal text-text-muted mt-1">
                    Included in total tokens
                  </div>
                </>
              }
            />
          </div>
          {(s.unpricedRuns > 0 || s.unmeasuredRuns > 0 || s.historicalRuns > 0) && (
            <div className="flex gap-3 rounded-xl border border-border/70 bg-bg-card/30 px-4 py-3 text-xs leading-relaxed text-text-muted">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <p>
                {s.unpricedRuns > 0 && `${s.unpricedRuns} runs have no reported cost. `}
                {s.unmeasuredRuns > 0 && `${s.unmeasuredRuns} have no token measurements. `}
                {s.historicalRuns > 0 &&
                  `${s.historicalRuns} historical runs are dated by completion or last update; their original daily timing is unavailable. `}
                Costs include API-equivalent estimates and may differ from your provider bill.
              </p>
            </div>
          )}
          <Panel
            title="Usage over time"
            actions={
              <Segmented
                aria-label="Chart metric"
                value={chart}
                onChange={setChart}
                options={[
                  { value: "tokens", label: "Tokens" },
                  { value: "cost", label: "Cost" },
                ]}
              />
            }
          >
            {s.runs === 0 ? (
              <PanelEmpty className="py-16 text-center">
                No recorded usage in this period. Usage appears as work reports it.
              </PanelEmpty>
            ) : (
              <div className="p-4">
                <ResponsiveContainer width="100%" height={210}>
                  <AreaChart
                    data={data.daily.map((d) => ({
                      ...d,
                      cost: d.costUsd === null ? null : Number(d.costUsd),
                    }))}
                    margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#7c3aed" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      vertical={false}
                      stroke="var(--color-border)"
                      strokeDasharray="3 4"
                    />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(d) => String(d).slice(5)}
                      tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={28}
                    />
                    <YAxis
                      width={64}
                      tickFormatter={(v) =>
                        chart === "tokens" ? formatTokens(Number(v)) : formatUsd(Number(v))
                      }
                      tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      formatter={(v) => [
                        chart === "tokens" ? Number(v).toLocaleString() : formatUsd(Number(v)),
                        chart === "tokens" ? "Tokens" : "Cost",
                      ]}
                      contentStyle={{
                        background: "var(--color-bg-card)",
                        border: "1px solid var(--color-border)",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey={chart}
                      stroke="#7c3aed"
                      strokeWidth={2}
                      fill="url(#usage-fill)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Panel>
          {!selected && (
            <Panel
              title="Usage leaderboard"
              actions={<span>Ranked by {query.sort ?? "tokens"}</span>}
            >
              <div className="p-4 flex flex-wrap items-center gap-3 border-b border-border/50">
                <Segmented
                  aria-label="Leaderboard scope"
                  value={query.kind ?? "all"}
                  onChange={(kind) => filter({ kind })}
                  options={[
                    { value: "all", label: "All" },
                    { value: "person", label: "People" },
                    { value: "work", label: "Organization work" },
                  ]}
                />
                <div className="relative flex-1 min-w-40">
                  <Search className="absolute left-3 top-2.5 w-4 h-4 text-text-muted" />
                  <input
                    aria-label="Search leaderboard"
                    placeholder="Find people or work…"
                    value={query.q ?? ""}
                    onChange={(e) => filter({ q: e.target.value })}
                    className={inputClass({ className: "w-full pl-9" })}
                  />
                </div>
                <select
                  aria-label="Rank by"
                  value={query.sort}
                  onChange={(e) => filter({ sort: e.target.value as UsageQuery["sort"] })}
                  className={inputClass({ className: "w-auto" })}
                >
                  <option value="tokens">Most tokens</option>
                  <option value="cost">Highest cost</option>
                  <option value="runs">Most runs</option>
                </select>
              </div>
              {!data.leaderboard.length ? (
                <PanelEmpty className="text-center py-12">
                  No matching people or work for this period.
                </PanelEmpty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-[11px] uppercase text-text-muted tracking-wide">
                      <tr>
                        <th className="text-left px-4 py-3 font-medium">Rank / name</th>
                        <th className="text-right px-4 font-medium">Tokens</th>
                        <th className="text-right px-4 font-medium">Cost</th>
                        <th className="text-right px-4 font-medium">Runs</th>
                        <th className="text-right px-4 font-medium hidden lg:table-cell">Trend</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {data.leaderboard.map((r) => (
                        <tr key={`${r.kind}:${r.id}`} className="hover:bg-bg-hover/40">
                          <td className="px-4 py-3">
                            <button
                              onClick={() => {
                                setSelected(r);
                                filter({ page: 0, q: undefined });
                              }}
                              className="flex items-center gap-3 text-left group max-w-full"
                            >
                              <span className="text-text-muted tabular-nums w-5 text-xs shrink-0">
                                {r.rank}
                              </span>
                              <span className="rounded-lg bg-primary/10 text-primary p-2 shrink-0">
                                {r.kind === "person" ? (
                                  <Users className="w-4 h-4" />
                                ) : (
                                  <Building2 className="w-4 h-4" />
                                )}
                              </span>
                              <span className="min-w-0">
                                <span className="block font-medium text-text-heading group-hover:text-primary max-w-56 truncate">
                                  {r.name}
                                </span>
                                <span className="block text-[11px] text-text-muted">
                                  {r.kind === "person" ? "Person" : "Organization work"}
                                </span>
                              </span>
                            </button>
                          </td>
                          <td
                            className="text-right px-4 tabular-nums font-medium"
                            title={`${r.tokens.toLocaleString()} tokens`}
                          >
                            {formatTokens(r.tokens)}
                          </td>
                          <td className="text-right px-4 tabular-nums whitespace-nowrap">
                            {money(r.costUsd)}
                            {r.estimatedCostUsd !== null && (
                              <span className="block text-[10px] text-text-muted">
                                includes estimates
                              </span>
                            )}
                          </td>
                          <td className="text-right px-4 tabular-nums">{r.runs}</td>
                          <td className="px-4 hidden lg:table-cell">
                            <div className="flex items-center justify-end gap-3">
                              <span className="text-[11px] text-text-muted tabular-nums">
                                {r.changePercent === null
                                  ? "New"
                                  : `${r.changePercent > 0 ? "+" : ""}${r.changePercent.toFixed(0)}%`}
                              </span>
                              <Sparkline values={r.trend} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="px-4 py-3 border-t border-border/50 flex items-center justify-between gap-3 text-xs text-text-muted">
                <p>Shared work is attributed to the organization, independent of who created it.</p>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    aria-label="Previous page"
                    variant="ghost"
                    size="sm"
                    disabled={!query.page || loading}
                    onClick={() => setQuery((q) => ({ ...q, page: (q.page ?? 0) - 1 }))}
                  >
                    <ChevronLeft />
                  </Button>
                  <span>
                    {(query.page ?? 0) + 1} /{" "}
                    {Math.max(1, Math.ceil(data.totalEntries / data.pageSize))}
                  </span>
                  <Button
                    aria-label="Next page"
                    variant="ghost"
                    size="sm"
                    disabled={
                      loading || ((query.page ?? 0) + 1) * data.pageSize >= data.totalEntries
                    }
                    onClick={() => setQuery((q) => ({ ...q, page: (q.page ?? 0) + 1 }))}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </Panel>
          )}
          {!selected && <TeamUsagePanel days={query.days ?? 30} />}
          {selected && (
            <Panel
              title={`${selected.name} · Recent activity`}
              actions={
                data.canManageBudgets ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setBudgetSubject(selected);
                      setBudget(data.budgets.find((b) => b.subjectId === selected.id) ?? true);
                    }}
                  >
                    Set budget
                  </Button>
                ) : undefined
              }
            >
              {!data.canInspect ? (
                <PanelEmpty>
                  Individual work details are visible to their owner and organization
                  administrators.
                </PanelEmpty>
              ) : !data.activity.length ? (
                <PanelEmpty>No visible runs in this period.</PanelEmpty>
              ) : (
                <div className="divide-y divide-border/40">
                  {data.activity.map((a) => (
                    <Link
                      key={a.id}
                      href={a.href}
                      className="flex justify-between gap-4 p-4 hover:bg-bg-hover/40"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm truncate">{a.name}</span>
                        <span className="block text-xs text-text-muted mt-1">
                          {a.model ?? "Model not reported"} ·{" "}
                          {new Date(a.lastUsed).toLocaleDateString()}
                        </span>
                      </span>
                      <span className="text-right shrink-0 text-sm tabular-nums">
                        {formatTokens(a.tokens)} tokens
                        <span className="block text-xs text-text-muted mt-1">
                          {money(a.costUsd)}
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </Panel>
          )}
          <div className="grid lg:grid-cols-2 gap-6">
            <Panel
              title="Models"
              actions={
                query.model ? (
                  <button onClick={() => filter({ model: undefined })}>Clear filter</button>
                ) : undefined
              }
            >
              {!data.models.length ? (
                <PanelEmpty>No model usage recorded.</PanelEmpty>
              ) : (
                <div className="p-4 space-y-4">
                  {data.models.map((m) => (
                    <button
                      key={m.model}
                      // "Not reported" is a bucket of its own: the API filters on it too.
                      onClick={() => filter({ model: m.model })}
                      className="block w-full text-left group"
                    >
                      <div className="flex justify-between gap-3 text-xs mb-2">
                        <span className="truncate group-hover:text-primary">{m.model}</span>
                        <span className="text-text-muted shrink-0 tabular-nums">
                          {formatTokens(m.tokens)} · {money(m.costUsd)}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-bg-hover overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary/60"
                          style={{
                            width: `${(m.tokens / Math.max(1, data.models[0]?.tokens)) * 100}%`,
                          }}
                        />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </Panel>
            <Panel
              title="Monthly budgets"
              actions={
                data.canManageBudgets ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setBudgetSubject(null);
                      setBudget(data.budgets.find((b) => b.subjectKind === "organization") ?? true);
                    }}
                  >
                    Organization budget
                  </Button>
                ) : undefined
              }
            >
              {!data.budgets.length ? (
                <PanelEmpty className="py-8 leading-relaxed">
                  No budgets set. Administrators can set a monthly organization limit or select a
                  person or work from the leaderboard.
                </PanelEmpty>
              ) : (
                <div className="p-4 space-y-5">
                  {data.budgets.map((b) => (
                    <div key={b.id}>
                      <div className="flex justify-between gap-3 text-sm mb-2">
                        <button
                          disabled={!data.canManageBudgets}
                          onClick={() => setBudget(b)}
                          className="text-left hover:text-primary disabled:hover:text-text"
                        >
                          {b.name}
                        </button>
                        <span className={b.fraction >= 1 ? "text-warning" : "text-text-muted"}>
                          {b.enabled ? `${Math.round(b.fraction * 100)}%` : "Disabled"}
                        </span>
                      </div>
                      <div className="h-1.5 bg-bg-hover rounded-full overflow-hidden">
                        <div
                          className={b.fraction >= 1 ? "h-full bg-warning" : "h-full bg-primary/60"}
                          style={{ width: `${Math.min(100, b.fraction * 100)}%` }}
                        />
                      </div>
                      <p className="text-xs text-text-muted mt-2">
                        {b.tokenLimit
                          ? `${formatTokens(b.usedTokens)} / ${formatTokens(b.tokenLimit)} tokens`
                          : ""}
                        {b.tokenLimit && b.costLimit ? " · " : ""}
                        {b.costLimit ? `${money(b.usedCostUsd)} / ${money(b.costLimit)}` : ""}
                        <span className="block mt-1">
                          {b.action === "pause_new" ? "Pauses new work at limit" : "Alert at limit"}{" "}
                          · Calendar month (UTC)
                        </span>
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
          <p className="text-xs text-text-muted leading-relaxed">
            Usage measures activity, not individual performance. A run may span several days. Model
            estimates use known rates; unpriced usage remains visible.{" "}
            {Number(s.retryCostUsd) > 0 &&
              `${money(s.retryCostUsd)} was recorded on retry attempts.`}
          </p>
        </>
      )}
      {budget && (
        <BudgetDialog
          budget={budget === true ? undefined : budget}
          subject={budget === true ? (budgetSubject ?? undefined) : undefined}
          onClose={() => setBudget(null)}
          onSaved={() => setVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}
