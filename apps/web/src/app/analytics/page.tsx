"use client";

import { useEffect, useState, useCallback } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { classifyError } from "@optio/shared";
import {
  BarChart3,
  Hourglass,
  Clock,
  CheckCircle2,
  GitPullRequest,
  RefreshCw,
  Zap,
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
  Legend,
} from "recharts";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { StatTile } from "@/components/ui/stat-tile";
import { AgentIcon } from "@/components/brand-icon";

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

/** StatTile with a quiet caption line under the number. */
function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <StatTile
      label={label}
      icon={icon}
      value={
        <>
          {value}
          {sub && (
            <div className="text-xs font-normal text-text-muted mt-0.5 tracking-normal">{sub}</div>
          )}
        </>
      }
    />
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

  // Every section below hides itself when it has nothing to show; when all of
  // them do, the page shows one empty state instead of a blank area.
  const hasAnyData =
    (performance?.tasksPerDay.length ?? 0) > 0 ||
    (agents?.agents.length ?? 0) > 0 ||
    failureCategories.length > 0 ||
    (failures?.failureByRepo.length ?? 0) > 0 ||
    (prs?.totalPrs ?? 0) > 0;

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={BarChart3}
        title="Analytics"
        description="How the agents are doing: success rates, durations, agent comparison, failures, and the PR funnel."
        actions={
          <Segmented
            aria-label="Period"
            surface="card"
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={PERIOD_OPTIONS.map((o) => ({ value: String(o.days), label: o.label }))}
          />
        }
      />

      {loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-[84px] skeleton-shimmer rounded-xl" />
            ))}
          </div>
          <div className="h-[330px] skeleton-shimmer rounded-xl" />
          <div className="h-40 skeleton-shimmer rounded-xl" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Performance Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat
              label="Success Rate"
              value={`${performance?.successRate ?? 0}%`}
              sub={
                performance?.successRateTrend
                  ? `${performance.successRateTrend > 0 ? "+" : ""}${performance.successRateTrend}pp vs prev`
                  : undefined
              }
              icon={CheckCircle2}
            />
            <Stat
              label="Avg Duration"
              value={formatDuration(performance?.durations.avgExecution ?? 0)}
              sub={`p95: ${formatDuration(performance?.durations.p95Execution ?? 0)}`}
              icon={Clock}
            />
            <Stat
              label="Queue Wait"
              value={formatDuration(performance?.durations.avgQueueWait ?? 0)}
              sub={`${performance?.durations.taskCount ?? 0} completed tasks`}
              icon={Hourglass}
            />
            <Stat
              label="PR Merge Rate"
              value={`${prs?.autoMergeRate ?? 0}%`}
              sub={`${prs?.merged ?? 0} of ${prs?.totalPrs ?? 0} PRs merged`}
              icon={GitPullRequest}
            />
          </div>

          {/* Performance Over Time */}
          {performance && performance.tasksPerDay.length > 0 && (
            <Panel title="Tasks over time">
              <div className="p-4">
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
            </Panel>
          )}

          {/* Agent Comparison */}
          {agents && agents.agents.length > 0 && (
            <Panel
              title="Agent comparison"
              actions={
                <span className="hidden sm:flex items-center gap-6 text-[10px] uppercase tracking-wider text-text-muted/70">
                  <span className="w-14 text-right">Success</span>
                  <span className="w-16 text-right">Duration</span>
                  <span className="w-16 text-right">Cost</span>
                  <span className="w-12 text-right">Retries</span>
                </span>
              }
            >
              <div className="divide-y divide-border/40">
                {agents.agents.map((agent) => (
                  <div
                    key={agent.agentType}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover/40 transition-colors"
                  >
                    <span className="w-7 h-7 rounded-md bg-bg flex items-center justify-center shrink-0 text-text-muted">
                      <AgentIcon runtime={agent.agentType} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-text capitalize truncate">
                        {agent.agentType}
                      </div>
                      <div className="text-[11px] text-text-muted truncate mt-0.5">
                        {agent.taskCount} task{agent.taskCount !== 1 ? "s" : ""}
                        {agent.models.length > 0 &&
                          ` · ${agent.models
                            .map((m) => m.model.split("-").slice(-2, -1)[0] || m.model)
                            .join(", ")}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm tabular-nums shrink-0">
                      <span
                        className={cn(
                          "w-14 text-right font-medium",
                          agent.successRate >= 80
                            ? "text-success"
                            : agent.successRate >= 50
                              ? "text-warning"
                              : "text-error",
                        )}
                        title="Success rate"
                      >
                        {agent.successRate}%
                      </span>
                      <span
                        className="w-16 text-right text-text-muted hidden sm:inline"
                        title="Avg duration"
                      >
                        {formatDuration(agent.avgDuration)}
                      </span>
                      <span
                        className="w-16 text-right text-text-muted hidden sm:inline"
                        title="Avg cost"
                      >
                        {formatCost(agent.avgCost)}
                      </span>
                      <span
                        className="w-12 text-right text-text-muted hidden sm:inline"
                        title="Avg retries"
                      >
                        {agent.avgRetries.toFixed(1)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {/* Failure Breakdown */}
          {failureCategories.length > 0 && (
            <Panel title="Failure breakdown">
              <div className="p-4">
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
              </div>
              {/* Retry & Stall Stats */}
              {failures && (
                <div className="flex items-center gap-x-6 gap-y-1 flex-wrap px-4 py-2.5 text-xs text-text-muted border-t border-border/60 bg-bg-card/30">
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
            </Panel>
          )}

          {/* Failure by Repo */}
          {failures && failures.failureByRepo.length > 0 && (
            <div className="grid md:grid-cols-2 gap-4">
              <Panel title="Failure rate by repo">
                <div className="p-4 space-y-3">
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
              </Panel>

              {/* Failure by Model */}
              {failures.failureByModel.length > 0 && (
                <Panel title="Failure rate by model">
                  <div className="p-4 space-y-3">
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
                </Panel>
              )}
            </div>
          )}

          {/* PR Lifecycle Funnel */}
          {prs && prs.totalPrs > 0 && (
            <Panel title="PR lifecycle funnel">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4">
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
              <div className="flex items-center gap-x-6 gap-y-1 flex-wrap px-4 py-2.5 text-xs text-text-muted border-t border-border/60 bg-bg-card/30">
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
            </Panel>
          )}

          {!hasAnyData && (
            <EmptyState
              icon={BarChart3}
              title="No runs in this period"
              description="Charts appear here once tasks have run. Try a longer period."
            />
          )}
        </div>
      )}
    </div>
  );
}
