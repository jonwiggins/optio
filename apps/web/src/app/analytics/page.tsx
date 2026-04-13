"use client";

import { useEffect, useState, useCallback } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { classifyError } from "@optio/shared";
import Link from "next/link";
import {
  BarChart3,
  Loader2,
  Clock,
  CheckCircle2,
  AlertTriangle,
  GitPullRequest,
  RefreshCw,
  Users,
  Zap,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Legend,
} from "recharts";

type PerformanceData = Awaited<ReturnType<typeof api.getPerformanceAnalytics>>;
type AgentData = Awaited<ReturnType<typeof api.getAgentAnalytics>>;
type FailureData = Awaited<ReturnType<typeof api.getFailureAnalytics>>;
type PrData = Awaited<ReturnType<typeof api.getPrAnalytics>>;

const PERIOD_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

const CATEGORY_COLORS: Record<string, string> = {
  image: "#f06060",
  auth: "#f0a040",
  network: "#60a5fa",
  timeout: "#c084fc",
  agent: "#fb923c",
  state: "#38bdf8",
  resource: "#f06060",
  unknown: "#807c88",
};

function formatDuration(seconds: number): string {
  if (seconds === 0) return "\u2014";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatCost(value: string | number): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n) || n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function repoShortName(repoUrl: string): string {
  const match = repoUrl.match(/([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : repoUrl;
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
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  color?: string;
}) {
  return (
    <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5 card-hover">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-text-muted font-semibold uppercase tracking-widest">
          {label}
        </span>
        <Icon className={cn("w-4 h-4", color ?? "text-text-muted/50")} />
      </div>
      <div className="text-2xl font-bold tracking-tight text-text">{value}</div>
      {sub && <div className="mt-1.5 text-xs text-text-muted">{sub}</div>}
    </div>
  );
}

export default function AnalyticsPage() {
  usePageTitle("Analytics");
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [performance, setPerformance] = useState<PerformanceData | null>(null);
  const [agents, setAgents] = useState<AgentData | null>(null);
  const [failures, setFailures] = useState<FailureData | null>(null);
  const [prs, setPrs] = useState<PrData | null>(null);

  const fetchAll = useCallback(async (d: number) => {
    setLoading(true);
    try {
      const [perf, ag, fail, pr] = await Promise.all([
        api.getPerformanceAnalytics({ days: d }),
        api.getAgentAnalytics({ days: d }),
        api.getFailureAnalytics({ days: d }),
        api.getPrAnalytics({ days: d }),
      ]);
      setPerformance(perf);
      setAgents(ag);
      setFailures(fail);
      setPrs(pr);
    } catch {
      // fail silently — sections show empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll(days);
  }, [days, fetchAll]);

  // Classify failure messages into categories
  const failureCategories = failures
    ? (() => {
        const map = new Map<string, { category: string; title: string; count: number }>();
        for (const err of failures.errorMessages) {
          const classified = classifyError(err.message);
          const existing = map.get(classified.category);
          if (existing) {
            existing.count += err.count;
          } else {
            map.set(classified.category, {
              category: classified.category,
              title: classified.title,
              count: err.count,
            });
          }
        }
        return [...map.values()].sort((a, b) => b.count - a.count);
      })()
    : [];

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6 stagger">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gradient">Analytics</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Performance, agent comparison, and failure insights
          </p>
        </div>
        <div className="flex items-center gap-2">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              onClick={() => setDays(opt.days)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
                days === opt.days
                  ? "bg-primary text-white"
                  : "bg-bg-card text-text-muted hover:bg-bg-hover border border-border/50",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
        </div>
      ) : (
        <>
          {/* Performance Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Success Rate"
              value={`${performance?.successRate ?? 0}%`}
              sub={
                performance?.successRateTrend
                  ? `${performance.successRateTrend > 0 ? "+" : ""}${performance.successRateTrend}pp vs prev`
                  : undefined
              }
              icon={CheckCircle2}
              color="text-success"
            />
            <StatCard
              label="Avg Duration"
              value={formatDuration(performance?.durations.avgExecution ?? 0)}
              sub={`p95: ${formatDuration(performance?.durations.p95Execution ?? 0)}`}
              icon={Clock}
              color="text-info"
            />
            <StatCard
              label="Queue Wait"
              value={formatDuration(performance?.durations.avgQueueWait ?? 0)}
              sub={`${performance?.durations.taskCount ?? 0} completed tasks`}
              icon={Clock}
            />
            <StatCard
              label="PR Merge Rate"
              value={`${prs?.autoMergeRate ?? 0}%`}
              sub={`${prs?.merged ?? 0} of ${prs?.totalPrs ?? 0} PRs merged`}
              icon={GitPullRequest}
              color="text-primary"
            />
          </div>

          {/* Performance Over Time */}
          {performance && performance.tasksPerDay.length > 0 && (
            <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-text-muted mb-4">
                Tasks Over Time
              </h3>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={performance.tasksPerDay}>
                  <defs>
                    <linearGradient id="successGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#34d399" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="failGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f06060" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f06060" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    tickFormatter={(v) => {
                      const d = new Date(v);
                      return `${d.getMonth() + 1}/${d.getDate()}`;
                    }}
                  />
                  <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} allowDecimals={false} />
                  <Tooltip content={<ChartTooltipContent />} />
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="succeeded"
                    name="Succeeded"
                    stroke="#34d399"
                    fill="url(#successGrad)"
                    stackId="1"
                  />
                  <Area
                    type="monotone"
                    dataKey="failed"
                    name="Failed"
                    stroke="#f06060"
                    fill="url(#failGrad)"
                    stackId="1"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Agent Comparison Table */}
          {agents && agents.agents.length > 0 && (
            <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-text-muted">
                  Agent Comparison
                </h3>
                <Users className="w-4 h-4 text-text-muted/50" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="text-left py-2 px-3 text-xs text-text-muted font-medium uppercase tracking-wider">
                        Agent
                      </th>
                      <th className="text-right py-2 px-3 text-xs text-text-muted font-medium uppercase tracking-wider">
                        Tasks
                      </th>
                      <th className="text-right py-2 px-3 text-xs text-text-muted font-medium uppercase tracking-wider">
                        Success
                      </th>
                      <th className="text-right py-2 px-3 text-xs text-text-muted font-medium uppercase tracking-wider">
                        Avg Duration
                      </th>
                      <th className="text-right py-2 px-3 text-xs text-text-muted font-medium uppercase tracking-wider">
                        Avg Cost
                      </th>
                      <th className="text-right py-2 px-3 text-xs text-text-muted font-medium uppercase tracking-wider">
                        Retries
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.agents.map((agent) => (
                      <tr
                        key={agent.agentType}
                        className="border-b border-border/30 hover:bg-bg-hover/40 transition-colors"
                      >
                        <td className="py-2.5 px-3 font-medium text-text capitalize">
                          {agent.agentType}
                          {agent.models.length > 0 && (
                            <span className="block text-xs text-text-muted mt-0.5">
                              {agent.models
                                .map((m) => m.model.split("-").slice(-2, -1)[0] || m.model)
                                .join(", ")}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-text">
                          {agent.taskCount}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span
                            className={cn(
                              "tabular-nums font-medium",
                              agent.successRate >= 80
                                ? "text-success"
                                : agent.successRate >= 50
                                  ? "text-warning"
                                  : "text-error",
                            )}
                          >
                            {agent.successRate}%
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-text-muted">
                          {formatDuration(agent.avgDuration)}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-text-muted">
                          {formatCost(agent.avgCost)}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-text-muted">
                          {agent.avgRetries.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Failure Breakdown */}
          {failureCategories.length > 0 && (
            <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-text-muted">
                  Failure Breakdown
                </h3>
                <AlertTriangle className="w-4 h-4 text-text-muted/50" />
              </div>
              <ResponsiveContainer
                width="100%"
                height={Math.max(200, failureCategories.length * 40)}
              >
                <BarChart data={failureCategories} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    type="number"
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="title"
                    tick={{ fill: "#6b7280", fontSize: 11 }}
                    width={180}
                  />
                  <Tooltip
                    content={({ active, payload }) =>
                      active && payload?.[0] ? (
                        <div className="glass-tooltip px-3 py-2">
                          <p className="text-sm font-medium text-text">
                            {(payload[0].payload as { title: string }).title}: {payload[0].value}
                          </p>
                        </div>
                      ) : null
                    }
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]} fill="#f06060">
                    {failureCategories.map((entry, i) => (
                      <rect
                        key={i}
                        fill={CATEGORY_COLORS[entry.category] ?? CATEGORY_COLORS.unknown}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              {/* Retry & Stall Stats */}
              {failures && (
                <div className="mt-4 flex items-center gap-6 text-sm text-text-muted border-t border-border/30 pt-4">
                  <span className="flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry success rate:{" "}
                    <strong className="text-text">{failures.retrySuccessRate}%</strong>
                    <span className="text-text-muted/60">
                      ({failures.retrySucceededCount}/{failures.retriedCount})
                    </span>
                  </span>
                  {failures.stallCount > 0 && (
                    <span className="flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5" />
                      Stalls: <strong className="text-text">{failures.stallCount}</strong>
                      <span className="text-text-muted/60">
                        ({failures.stallRecoveryRate}% recovered)
                      </span>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Failure by Repo */}
          {failures && failures.failureByRepo.length > 0 && (
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-text-muted mb-4">
                  Failure Rate by Repo
                </h3>
                <div className="space-y-3">
                  {failures.failureByRepo.slice(0, 8).map((r) => (
                    <div key={r.repoUrl} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text truncate max-w-[200px]">
                          {repoShortName(r.repoUrl)}
                        </span>
                        <span
                          className={cn(
                            "text-xs font-medium tabular-nums",
                            r.failureRate >= 30
                              ? "text-error"
                              : r.failureRate >= 15
                                ? "text-warning"
                                : "text-text-muted",
                          )}
                        >
                          {r.failureRate}% ({r.failed}/{r.total})
                        </span>
                      </div>
                      <div className="h-1.5 bg-bg-hover rounded-full overflow-hidden">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            r.failureRate >= 30
                              ? "bg-error"
                              : r.failureRate >= 15
                                ? "bg-warning"
                                : "bg-text-muted/30",
                          )}
                          style={{ width: `${r.failureRate}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Failure by Model */}
              {failures.failureByModel.length > 0 && (
                <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-text-muted mb-4">
                    Failure Rate by Model
                  </h3>
                  <div className="space-y-3">
                    {failures.failureByModel.map((m) => (
                      <div key={m.model} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-text">{m.model}</span>
                          <span
                            className={cn(
                              "text-xs font-medium tabular-nums",
                              m.failureRate >= 30
                                ? "text-error"
                                : m.failureRate >= 15
                                  ? "text-warning"
                                  : "text-text-muted",
                            )}
                          >
                            {m.failureRate}% ({m.failed}/{m.total})
                          </span>
                        </div>
                        <div className="h-1.5 bg-bg-hover rounded-full overflow-hidden">
                          <div
                            className={cn(
                              "h-full rounded-full",
                              m.failureRate >= 30
                                ? "bg-error"
                                : m.failureRate >= 15
                                  ? "bg-warning"
                                  : "bg-text-muted/30",
                            )}
                            style={{ width: `${m.failureRate}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PR Lifecycle Funnel */}
          {prs && prs.totalPrs > 0 && (
            <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-text-muted">
                  PR Lifecycle Funnel
                </h3>
                <GitPullRequest className="w-4 h-4 text-text-muted/50" />
              </div>
              <div className="grid grid-cols-4 gap-3">
                {[
                  { label: "PR Opened", value: prs.funnel.prOpened, color: "bg-info" },
                  { label: "CI Passed", value: prs.funnel.ciPassed, color: "bg-warning" },
                  {
                    label: "Review Approved",
                    value: prs.funnel.reviewApproved,
                    color: "bg-primary",
                  },
                  { label: "Merged", value: prs.funnel.merged, color: "bg-success" },
                ].map((step, i) => {
                  const pct =
                    prs.funnel.prOpened > 0 ? (step.value / prs.funnel.prOpened) * 100 : 0;
                  return (
                    <div key={step.label} className="text-center">
                      <div className="relative mx-auto mb-2 w-full max-w-[100px]">
                        <div className="h-2 bg-bg-hover rounded-full overflow-hidden">
                          <div
                            className={cn("h-full rounded-full transition-all", step.color)}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                      <div className="text-lg font-bold tabular-nums text-text">{step.value}</div>
                      <div className="text-[10px] text-text-muted uppercase tracking-wider">
                        {step.label}
                      </div>
                      {i > 0 && prs.funnel.prOpened > 0 && (
                        <div className="text-[10px] text-text-muted/60 mt-0.5">
                          {Math.round(pct)}%
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex items-center gap-6 text-sm text-text-muted border-t border-border/30 pt-4">
                <span>
                  CI pass rate: <strong className="text-text">{prs.ciPassRate}%</strong>
                </span>
                <span>
                  Review approval: <strong className="text-text">{prs.reviewApprovalRate}%</strong>
                </span>
                <span>
                  Avg merge time:{" "}
                  <strong className="text-text">{formatDuration(prs.avgMergeTime)}</strong>
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
