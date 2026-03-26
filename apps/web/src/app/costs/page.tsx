"use client";

import { useEffect, useState, useCallback } from "react";
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
  Loader2,
  ArrowUpRight,
  AlertTriangle,
  Lightbulb,
  Calendar,
  Cpu,
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

type CostAnalytics = Awaited<ReturnType<typeof api.getCostAnalytics>>;

const PERIOD_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

const REPO_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#ec4899", // pink
  "#14b8a6", // teal
];

const MODEL_COLORS: Record<string, string> = {
  opus: "#6366f1",
  sonnet: "#8b5cf6",
  haiku: "#06b6d4",
  unknown: "#6b7280",
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

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  trend?: { value: number; label: string };
}) {
  return (
    <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5 card-hover">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-text-muted font-semibold uppercase tracking-widest">
          {label}
        </span>
        <Icon className="w-4 h-4 text-text-muted/50" />
      </div>
      <div className="text-2xl font-bold tracking-tight text-text">{value}</div>
      {(sub || trend) && (
        <div className="mt-1.5 flex items-center gap-2">
          {trend && (
            <span
              className={cn(
                "flex items-center gap-0.5 text-xs font-medium",
                trend.value > 0
                  ? "text-error"
                  : trend.value < 0
                    ? "text-success"
                    : "text-text-muted",
              )}
            >
              {trend.value > 0 ? (
                <TrendingUp className="w-3 h-3" />
              ) : trend.value < 0 ? (
                <TrendingDown className="w-3 h-3" />
              ) : (
                <Minus className="w-3 h-3" />
              )}
              {trend.value > 0 ? "+" : ""}
              {trend.value.toFixed(1)}%
            </span>
          )}
          {sub && <span className="text-xs text-text-muted">{sub}</span>}
        </div>
      )}
    </div>
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

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-text-muted mb-2">{error}</p>
          <button onClick={loadData} className="text-sm text-primary hover:underline">
            Retry
          </button>
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

  // Build anomaly ID set for highlighting in top tasks table
  const anomalyIds = new Set(anomalies.map((a) => a.id));

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-text">Cost Analytics</h1>
          <p className="text-sm text-text-muted mt-0.5 font-light">
            Track and analyze agent spend across your tasks
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Repo filter */}
          <select
            value={repoFilter}
            onChange={(e) => setRepoFilter(e.target.value)}
            className="bg-bg-card border border-border rounded-lg px-3 py-1.5 text-sm text-text focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">All repos</option>
            {repos.map((r: { repoUrl: string; fullName?: string }) => (
              <option key={r.repoUrl} value={r.repoUrl}>
                {r.fullName || repoShortName(r.repoUrl)}
              </option>
            ))}
          </select>
          {/* Period selector */}
          <div className="flex bg-bg-card border border-border rounded-lg overflow-hidden">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                onClick={() => setDays(opt.days)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  days === opt.days
                    ? "bg-primary text-white"
                    : "text-text-muted hover:text-text hover:bg-bg-hover",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          label="Total Spend"
          value={formatCost(summary.totalCost)}
          icon={DollarSign}
          trend={{ value: trend, label: "vs prev period" }}
          sub={`last ${summary.days}d`}
        />
        <StatCard
          label="Average Cost"
          value={formatCost(summary.avgCost)}
          icon={BarChart3}
          sub={`across ${summary.tasksWithCost} tasks`}
        />
        <StatCard
          label="Monthly Forecast"
          value={formatCost(forecast.forecastedMonthTotal)}
          icon={Calendar}
          sub={`${formatCost(forecast.monthCostSoFar)} spent · ${forecast.daysRemaining}d left`}
        />
        <StatCard
          label="Prev Period"
          value={formatCost(summary.prevPeriodCost)}
          icon={DollarSign}
          sub={`previous ${summary.days}d`}
        />
      </div>

      {/* Model suggestions banner */}
      {modelSuggestions.length > 0 && (
        <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <Lightbulb className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-medium text-text mb-1">Cost Optimization Suggestions</h3>
              <div className="space-y-1.5">
                {modelSuggestions.map((s, i) => {
                  const savings = s.avgCost - s.cheaperModelAvgCost;
                  const savingsPercent = s.avgCost > 0 ? (savings / s.avgCost) * 100 : 0;
                  return (
                    <p key={i} className="text-xs text-text-muted">
                      <span className="text-text">{repoShortName(s.repoUrl)}</span>: {s.taskCount}{" "}
                      tasks ran with {modelShortName(s.currentModel)} (avg {formatCost(s.avgCost)}).
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
        <div className="bg-error/5 border border-error/20 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-error mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-medium text-text mb-1">
                Cost Anomalies ({anomalies.length})
              </h3>
              <p className="text-xs text-text-muted mb-2">
                These tasks cost 3x or more than the repository average:
              </p>
              <div className="space-y-1">
                {anomalies.slice(0, 5).map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-xs">
                    <Link
                      href={`/tasks/${a.id}`}
                      className="text-text hover:text-primary flex items-center gap-1"
                    >
                      {truncate(a.title, 40)}
                      <ArrowUpRight className="w-3 h-3 text-text-muted" />
                    </Link>
                    <span className="text-error font-medium">{formatCost(a.costUsd)}</span>
                    <span className="text-text-muted">
                      ({a.costRatio.toFixed(1)}x avg of {formatCost(a.repoAvgCost)})
                    </span>
                    <span className="text-text-muted">· {modelShortName(a.modelUsed)}</span>
                  </div>
                ))}
                {anomalies.length > 5 && (
                  <p className="text-xs text-text-muted">+{anomalies.length - 5} more anomalies</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cost over time chart */}
      <div className="bg-bg-card border border-border/50 rounded-xl p-5">
        <h2 className="text-sm font-medium text-text-heading mb-4">Cost Over Time</h2>
        {dailyCosts.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-text-muted text-sm">
            No cost data for this period
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={dailyCosts}>
              <defs>
                <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
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
                stroke="#6366f1"
                fill="url(#costGradient)"
                strokeWidth={2}
                animationDuration={800}
                animationEasing="ease-out"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Three-column layout: Cost by Model + Cost by Repo + Cost by Type */}
      <div className="grid grid-cols-3 gap-4">
        {/* Cost by model */}
        <div className="bg-bg-card border border-border/50 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Cpu className="w-4 h-4 text-text-muted/60" />
            <h2 className="text-sm font-medium text-text-heading">Cost by Model</h2>
          </div>
          {costByModel.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-text-muted text-sm">
              No data
            </div>
          ) : (
            <div className="space-y-3">
              {costByModel.map((m) => {
                const maxCost = costByModel[0]?.totalCost || 1;
                const pct = (m.totalCost / maxCost) * 100;
                return (
                  <div key={m.model}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text font-medium">
                        {modelShortName(m.model)}
                      </span>
                      <span className="text-xs text-text-muted">{formatCost(m.totalCost)}</span>
                    </div>
                    <div className="h-2 bg-bg rounded-full overflow-hidden">
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
                      <span className="text-[10px] text-text-muted">
                        avg {formatCost(m.avgCost)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Cost by repo */}
        <div className="bg-bg-card border border-border/50 rounded-xl p-5">
          <h2 className="text-sm font-medium text-text-heading mb-4">Cost by Repository</h2>
          {costByRepo.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-text-muted text-sm">
              No data
            </div>
          ) : (
            <div className="space-y-3">
              {costByRepo.map((r, i) => {
                const maxCost = costByRepo[0]?.totalCost || 1;
                const pct = (r.totalCost / maxCost) * 100;
                return (
                  <div key={r.repoUrl}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-text truncate max-w-[60%]">
                        {repoShortName(r.repoUrl)}
                      </span>
                      <span className="text-xs text-text-muted">
                        {formatCost(r.totalCost)} ({r.taskCount} tasks)
                      </span>
                    </div>
                    <div className="h-2 bg-bg rounded-full overflow-hidden">
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
        </div>

        {/* Cost by task type */}
        <div className="bg-bg-card border border-border/50 rounded-xl p-5">
          <h2 className="text-sm font-medium text-text-heading mb-4">Cost by Task Type</h2>
          {costByType.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-text-muted text-sm">
              No data
            </div>
          ) : (
            <div>
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
                      <Cell key={i} fill={i === 0 ? "#6366f1" : "#8b5cf6"} stroke="none" />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value) => formatCost(Number(value))}
                    contentStyle={{
                      backgroundColor: "var(--color-bg-card, #1a1a2e)",
                      border: "1px solid var(--color-border, #2a2a3e)",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex justify-center gap-6 mt-2">
                {costByType.map((t, i) => (
                  <div key={t.taskType} className="flex items-center gap-2">
                    <div
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: i === 0 ? "#6366f1" : "#8b5cf6" }}
                    />
                    <span className="text-xs text-text-muted">
                      {t.taskType} — {formatCost(t.totalCost)} ({t.taskCount})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Top most expensive tasks with token breakdown */}
      <div className="bg-bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-medium text-text mb-4">Most Expensive Tasks</h2>
        {topTasks.length === 0 ? (
          <div className="py-8 text-center text-text-muted text-sm">No tasks with cost data</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-xs font-medium text-text-muted">Task</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-text-muted">Repo</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-text-muted">Model</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-text-muted">Type</th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-text-muted">State</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-text-muted">Cost</th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-text-muted">
                    Tokens (In/Out)
                  </th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-text-muted">When</th>
                </tr>
              </thead>
              <tbody>
                {topTasks.map((task) => (
                  <tr
                    key={task.id}
                    className={cn(
                      "border-b border-border/50 hover:bg-bg-hover transition-colors",
                      anomalyIds.has(task.id) && "bg-error/5",
                    )}
                  >
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-1.5">
                        {anomalyIds.has(task.id) && (
                          <AlertTriangle className="w-3.5 h-3.5 text-error shrink-0" />
                        )}
                        <Link
                          href={`/tasks/${task.id}`}
                          className="text-text hover:text-primary flex items-center gap-1"
                        >
                          {truncate(task.title, 40)}
                          <ArrowUpRight className="w-3 h-3 text-text-muted" />
                        </Link>
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-text-muted text-xs">
                      {repoShortName(task.repoUrl)}
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className="text-xs px-2 py-0.5 rounded-full"
                        style={{
                          backgroundColor: `${getModelColor(task.modelUsed)}15`,
                          color: getModelColor(task.modelUsed),
                        }}
                      >
                        {modelShortName(task.modelUsed)}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={cn(
                          "text-xs px-2 py-0.5 rounded-full",
                          task.taskType === "review"
                            ? "bg-violet-500/10 text-violet-400"
                            : "bg-indigo-500/10 text-indigo-400",
                        )}
                      >
                        {task.taskType}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      <span className="text-xs text-text-muted">{task.state}</span>
                    </td>
                    <td className="py-2.5 px-3 text-right font-medium text-text">
                      {formatCost(task.costUsd)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-xs text-text-muted">
                      {task.inputTokens > 0 || task.outputTokens > 0 ? (
                        <span>
                          {formatTokens(task.inputTokens)} / {formatTokens(task.outputTokens)}
                        </span>
                      ) : (
                        <span className="text-text-muted/50">—</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right text-xs text-text-muted">
                      {formatRelativeTime(task.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
