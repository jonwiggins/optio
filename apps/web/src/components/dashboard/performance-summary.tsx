"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus, Clock, CheckCircle2, Activity } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";

type PerformanceData = Awaited<ReturnType<typeof api.getPerformanceAnalytics>>;

function formatDuration(seconds: number): string {
  if (seconds === 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function PerformanceSummary() {
  const [data, setData] = useState<PerformanceData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getPerformanceAnalytics({ days: 7 })
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5">
        <div className="h-4 w-32 skeleton-shimmer mb-4" />
        <div className="grid grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 skeleton-shimmer" />
          ))}
        </div>
      </div>
    );
  }

  if (!data || data.durations.taskCount === 0) return null;

  const sparkData = data.tasksPerDay.map((d) => ({
    date: d.date,
    tasks: d.total,
  }));

  return (
    <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5 card-hover">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-text-muted">
          Performance (7d)
        </h3>
        <Activity className="w-4 h-4 text-text-muted/50" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        {/* Success Rate */}
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-success" />
            <span className="text-[10px] text-text-muted uppercase tracking-wider">
              Success Rate
            </span>
          </div>
          <div className="text-xl font-bold text-text">{data.successRate}%</div>
          {data.successRateTrend !== 0 && (
            <div
              className={cn(
                "flex items-center gap-0.5 text-xs mt-0.5",
                data.successRateTrend > 0 ? "text-success" : "text-error",
              )}
            >
              {data.successRateTrend > 0 ? (
                <TrendingUp className="w-3 h-3" />
              ) : (
                <TrendingDown className="w-3 h-3" />
              )}
              {data.successRateTrend > 0 ? "+" : ""}
              {data.successRateTrend}pp
            </div>
          )}
          {data.successRateTrend === 0 && (
            <div className="flex items-center gap-0.5 text-xs mt-0.5 text-text-muted">
              <Minus className="w-3 h-3" />
              stable
            </div>
          )}
        </div>
        {/* Avg Duration */}
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <Clock className="w-3.5 h-3.5 text-info" />
            <span className="text-[10px] text-text-muted uppercase tracking-wider">
              Avg Duration
            </span>
          </div>
          <div className="text-xl font-bold text-text">
            {formatDuration(data.durations.avgExecution)}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            p95: {formatDuration(data.durations.p95Execution)}
          </div>
        </div>
        {/* Tasks/Day Sparkline */}
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <Activity className="w-3.5 h-3.5 text-primary" />
            <span className="text-[10px] text-text-muted uppercase tracking-wider">Tasks/Day</span>
          </div>
          {sparkData.length > 1 ? (
            <ResponsiveContainer width="100%" height={40}>
              <AreaChart data={sparkData}>
                <defs>
                  <linearGradient id="sparkGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Tooltip
                  content={({ active, payload }) =>
                    active && payload?.[0] ? (
                      <div className="glass-tooltip px-2 py-1 text-xs">
                        {payload[0].value} tasks
                      </div>
                    ) : null
                  }
                />
                <Area
                  type="monotone"
                  dataKey="tasks"
                  stroke="#7c3aed"
                  strokeWidth={1.5}
                  fill="url(#sparkGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-xl font-bold text-text">{sparkData[0]?.tasks ?? 0}</div>
          )}
        </div>
      </div>
    </div>
  );
}
