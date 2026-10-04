"use client";

import { useEffect, useState, useCallback, type ReactNode } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { cn, formatRelativeTime, truncate } from "@/lib/utils";
import Link from "next/link";
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Minus,
  BarChart3,
  AlertTriangle,
  Lightbulb,
  Calendar,
  History,
  RefreshCw,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
} from "recharts";
import { PageHeader } from "@/components/page-header";
import { StateBadge } from "@/components/state-badge";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { StatTile } from "@/components/ui/stat-tile";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

type CostAnalytics = Awaited<ReturnType<typeof api.getCostAnalytics>>;

const PERIOD_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

const REPO_COLORS = [
  "#7c3aed", // teal
  "#60a5fa", // sky
  "#34d399", // emerald
  "#f0a040", // amber
  "#f06060", // coral
  "#c084fc", // violet
  "#fb923c", // orange
  "#38bdf8", // cyan
];

const MODEL_COLORS: Record<string, string> = {
  opus: "#7c3aed",
  sonnet: "#60a5fa",
  haiku: "#34d399",
  unknown: "#807c88",
};

function repoShortName(repoUrl: string): string {
  const match = repoUrl.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : repoUrl;
}

function formatCost(value: string | number): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n) || n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count === 0) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function modelShortName(model: string): string {
  if (model === "unknown") return "Unknown";
  if (model.includes("opus")) return "Opus";
  if (model.includes("sonnet")) return "Sonnet";
  if (model.includes("haiku")) return "Haiku";
  return model;
}

function getModelColor(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return MODEL_COLORS.opus;
  if (lower.includes("sonnet")) return MODEL_COLORS.sonnet;
  if (lower.includes("haiku")) return MODEL_COLORS.haiku;
  return MODEL_COLORS.unknown;
}

/** A StatTile value with a quiet caption line under the number. */
function withSub(value: ReactNode, sub: ReactNode) {
  return (
    <>
      {value}
      <div className="text-xs font-normal text-text-muted mt-0.5 flex items-center gap-2 tracking-normal">
        {sub}
      </div>
    </>
  );
}

function TrendChip({ value }: { value: number }) {
  return (
    <span
      className={cn(
        "flex items-center gap-0.5 font-medium",
        value > 0 ? "text-error" : value < 0 ? "text-success" : "text-text-muted",
      )}
    >
      {value > 0 ? (
        <TrendingUp className="w-3 h-3" />
      ) : value < 0 ? (
        <TrendingDown className="w-3 h-3" />
      ) : (
        <Minus className="w-3 h-3" />
      )}
      {value > 0 ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

function ChartTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-tooltip px-3 py-2">
      <p className="text-xs text-text-muted mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-sm font-medium" style={{ color: p.color }}>
          {p.name}: {p.name === "Tasks" ? p.value : formatCost(p.value)}
        </p>
      ))}
    </div>
  );
}

export default function CostsPage() {
  usePageTitle("Costs");
  const [data, setData] = useState<CostAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [repoFilter, setRepoFilter] = useState<string>("");
  const [repos, setRepos] = useState<Array<{ repoUrl: string }>>([]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params: { days: number; repoUrl?: string } = { days };
      if (repoFilter) params.repoUrl = repoFilter;
      const result = await api.getCostAnalytics(params);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [days, repoFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Load repos for filter dropdown
  useEffect(() => {
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {});
  }, []);

  const header = (
    <PageHeader
      icon={DollarSign}
      title="Costs"
      description="What your agents spent, and where: by day, model, repository, and task."
      actions={
        <>
          <select
            aria-label="Repository"
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
            className={inputClass({ className: "w-auto h-[38px] bg-bg-card" })}
          >
            <option value="">All repos</option>
            {repos.map((r: { repoUrl: string; fullName?: string }) => (
              <option key={r.repoUrl} value={r.repoUrl}>
                {r.fullName || repoShortName(r.repoUrl)}
              </option>
            ))}
          </select>
          <Segmented
            aria-label="Period"
            surface="card"
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={PERIOD_OPTIONS.map((o) => ({ value: String(o.days), label: o.label }))}
          />
        </>
      }
    />
  );

  if (loading && !data) {
    return (
      <div className="page-column py-6">
        {header}
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-[84px] skeleton-shimmer rounded-xl" />
            ))}
          </div>
          <div className="h-[330px] skeleton-shimmer rounded-xl" />
          <div className="grid md:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-56 skeleton-shimmer rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="page-column py-6">
        {header}
        <div className="rounded-xl border border-dashed border-border/80 bg-bg-card/30 px-8 py-14 text-center">
          <p className="text-sm text-text-muted mb-3">{error}</p>
          <Button variant="secondary" size="sm" onClick={loadData}>
            <RefreshCw /> Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const {
    summary,
    forecast,
    dailyCosts,
    costByRepo,
    costByType,
    costByModel,
    anomalies,
    modelSuggestions,
    topTasks,
  } = data;
  const trend = parseFloat(summary.costTrend);

  // Build anomaly ID set for highlighting in top tasks list
  const anomalyIds = new Set(anomalies.map((a) => a.id));

  return (
    <div className="page-column py-6">
      {header}
      <div className="space-y-6">
        {/* Summary tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile
            label="Total spend"
            icon={DollarSign}
            value={withSub(
              formatCost(summary.totalCost),
              <>
                <TrendChip value={trend} />
                <span>last {summary.days}d</span>
              </>,
            )}
          />
          <StatTile
            label="Average cost"
            icon={BarChart3}
            value={withSub(formatCost(summary.avgCost), `across ${summary.tasksWithCost} tasks`)}
          />
          <StatTile
            label="Monthly forecast"
            icon={Calendar}
            value={withSub(
              formatCost(forecast.forecastedMonthTotal),
              `${formatCost(forecast.monthCostSoFar)} spent · ${forecast.daysRemaining}d left`,
            )}
          />
          <StatTile
            label="Prev period"
            icon={History}
            value={withSub(formatCost(summary.prevPeriodCost), `previous ${summary.days}d`)}
          />
        </div>

        {/* Model suggestions banner */}
        {modelSuggestions.length > 0 && (
          <div className="rounded-xl border border-warning/25 bg-warning/5 px-4 py-3">
            <div className="flex items-start gap-3">
              <Lightbulb className="w-4 h-4 text-warning mt-0.5 shrink-0" />
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-text-heading mb-1">
                  Cost optimization suggestions
                </h3>
                <div className="space-y-1.5">
                  {modelSuggestions.map((s, i) => {
                    const savings = s.avgCost - s.cheaperModelAvgCost;
                    const savingsPercent = s.avgCost > 0 ? (savings / s.avgCost) * 100 : 0;
                    return (
                      <p key={i} className="text-xs text-text-muted">
                        <span className="text-text">{repoShortName(s.repoUrl)}</span>: {s.taskCount}{" "}
                        tasks ran with {modelShortName(s.currentModel)} (avg {formatCost(s.avgCost)}
                        ).
                        {s.cheaperModelAvgCost > 0 ? (
                          <>
                            {" "}
                            Try Sonnet to save ~{savingsPercent.toFixed(0)}% ({formatCost(savings)}
                            /task).
                          </>
                        ) : (
                          <> Consider trying Sonnet for potential savings.</>
                        )}
                      </p>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Anomaly alerts */}
        {anomalies.length > 0 && (
          <div className="rounded-xl border border-error/25 bg-error/5 px-4 py-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-error mt-0.5 shrink-0" />
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-text-heading mb-1">
                  Cost anomalies ({anomalies.length})
                </h3>
                <p className="text-xs text-text-muted mb-2">
                  These tasks cost 3x or more than the repository average:
                </p>
                <div className="space-y-1">
                  {anomalies.slice(0, 5).map((a) => (
                    <div key={a.id} className="flex items-center gap-2 text-xs flex-wrap">
                      <Link href={a.href} className="text-text hover:text-primary">
                        {truncate(a.title, 40)}
                      </Link>
                      <span className="text-error font-medium tabular-nums">
                        {formatCost(a.costUsd)}
                      </span>
                      <span className="text-text-muted">
                        ({a.costRatio.toFixed(1)}x avg of {formatCost(a.repoAvgCost)})
                      </span>
                      <span className="text-text-muted">· {modelShortName(a.modelUsed)}</span>
                    </div>
                  ))}
                  {anomalies.length > 5 && (
                    <p className="text-xs text-text-muted">
                      +{anomalies.length - 5} more anomalies
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Cost over time chart */}
        <Panel title="Cost over time">
          {dailyCosts.length === 0 ? (
            <PanelEmpty className="py-10 text-center">No cost data for this period.</PanelEmpty>
          ) : (
            <div className="p-4">
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={dailyCosts}>
                  <defs>
                    <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => {
                      const d = new Date(v);
                      return `${d.getMonth() + 1}/${d.getDate()}`;
                    }}
                  />
                  <YAxis
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <Tooltip content={<ChartTooltipContent />} />
                  <Area
                    type="monotone"
                    dataKey="cost"
                    name="Cost"
                    stroke="#7c3aed"
                    fill="url(#costGradient)"
                    strokeWidth={2}
                    animationDuration={800}
                    animationEasing="ease-out"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        {/* Cost by model / repo / type */}
        <div className="grid md:grid-cols-3 gap-4">
          <Panel title="By model">
            {costByModel.length === 0 ? (
              <PanelEmpty>No data.</PanelEmpty>
            ) : (
              <div className="p-4 space-y-3">
                {costByModel.map((m) => {
                  const maxCost = costByModel[0]?.totalCost || 1;
                  const pct = (m.totalCost / maxCost) * 100;
                  return (
                    <div key={m.model}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-text font-medium">
                          {modelShortName(m.model)}
                        </span>
                        <span className="text-xs text-text-muted tabular-nums">
                          {formatCost(m.totalCost)}
                        </span>
                      </div>
                      <div className="h-1.5 bg-bg-hover rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: getModelColor(m.model),
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[10px] text-text-muted">
                          {m.taskCount} tasks · {m.successRate}% success
                        </span>
                        <span className="text-[10px] text-text-muted tabular-nums">
                          avg {formatCost(m.avgCost)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="By repository">
            {costByRepo.length === 0 ? (
              <PanelEmpty>No data.</PanelEmpty>
            ) : (
              <div className="p-4 space-y-3">
                {costByRepo.map((r, i) => {
                  const maxCost = costByRepo[0]?.totalCost || 1;
                  const pct = (r.totalCost / maxCost) * 100;
                  return (
                    <div key={r.repoUrl}>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-xs text-text truncate min-w-0">
                          {repoShortName(r.repoUrl)}
                        </span>
                        <span className="text-xs text-text-muted tabular-nums shrink-0">
                          {formatCost(r.totalCost)} ({r.taskCount} tasks)
                        </span>
                      </div>
                      <div className="h-1.5 bg-bg-hover rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: REPO_COLORS[i % REPO_COLORS.length],
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="By task type">
            {costByType.length === 0 ? (
              <PanelEmpty>No data.</PanelEmpty>
            ) : (
              <div className="p-4">
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={costByType.map((t) => ({
                        name: t.taskType,
                        value: t.totalCost,
                      }))}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={75}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {costByType.map((_, i) => (
                        <Cell key={i} fill={i === 0 ? "#7c3aed" : "#60a5fa"} stroke="none" />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => formatCost(Number(value))}
                      contentStyle={{
                        backgroundColor: "var(--color-bg-card, #1a1a20)",
                        border: "1px solid var(--color-border, #2c2c36)",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap justify-center gap-x-6 gap-y-1 mt-2">
                  {costByType.map((t, i) => (
                    <div key={t.taskType} className="flex items-center gap-2">
                      <div
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: i === 0 ? "#7c3aed" : "#60a5fa" }}
                      />
                      <span className="text-xs text-text-muted">
                        {t.taskType} — {formatCost(t.totalCost)} ({t.taskCount})
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Panel>
        </div>

        {/* Most expensive tasks, with token breakdown */}
        <Panel
          title="Most expensive tasks"
          actions={
            topTasks.length > 0 ? (
              <span className="text-text-muted">tokens in / out</span>
            ) : undefined
          }
        >
          {topTasks.length === 0 ? (
            <PanelEmpty className="py-6 text-sm text-center">No tasks with cost data.</PanelEmpty>
          ) : (
            <div className="divide-y divide-border/40">
              {topTasks.map((task) => {
                const anomalous = anomalyIds.has(task.id);
                return (
                  <Link
                    key={task.id}
                    href={task.href}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover/60 transition-colors min-w-0",
                      anomalous && "bg-error/5",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {anomalous && (
                          <AlertTriangle
                            className="w-3.5 h-3.5 text-error shrink-0"
                            aria-label="Cost anomaly"
                          />
                        )}
                        <span className="text-sm font-medium text-text truncate">
                          {truncate(task.title, 60)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-text-muted min-w-0">
                        <StateBadge state={task.state} />
                        <span className="font-mono truncate">{repoShortName(task.repoUrl)}</span>
                        <span
                          className="px-1.5 py-px rounded shrink-0"
                          style={{
                            backgroundColor: `${getModelColor(task.modelUsed)}15`,
                            color: getModelColor(task.modelUsed),
                          }}
                        >
                          {modelShortName(task.modelUsed)}
                        </span>
                        <span
                          className={cn(
                            "px-1.5 py-px rounded shrink-0",
                            task.taskType === "review"
                              ? "bg-info/10 text-info"
                              : "bg-primary/10 text-primary",
                          )}
                        >
                          {task.taskType}
                        </span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-medium text-text tabular-nums">
                        {formatCost(task.costUsd)}
                      </div>
                      <div className="text-[11px] text-text-muted tabular-nums mt-0.5">
                        {task.inputTokens > 0 || task.outputTokens > 0 ? (
                          <>
                            {formatTokens(task.inputTokens)} / {formatTokens(task.outputTokens)}
                          </>
                        ) : (
                          <span className="text-text-muted/50">—</span>
                        )}
                        <span className="text-text-muted/50"> · </span>
                        {formatRelativeTime(task.createdAt)}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
