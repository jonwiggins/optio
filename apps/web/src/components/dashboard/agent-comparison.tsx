"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Users } from "lucide-react";

type AgentData = Awaited<ReturnType<typeof api.getAgentAnalytics>>;

function formatCost(value: string | number): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n) || n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function AgentComparison() {
  const [data, setData] = useState<AgentData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getAgentAnalytics({ days: 7 })
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5">
        <div className="h-4 w-32 skeleton-shimmer mb-4" />
        <div className="space-y-3">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="h-12 skeleton-shimmer" />
          ))}
        </div>
      </div>
    );
  }

  // Only show if there are multiple agent types
  if (!data || data.agents.length < 2) return null;

  const maxTasks = Math.max(...data.agents.map((a) => a.taskCount));

  return (
    <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5 card-hover">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-text-muted">
          Agent Comparison (7d)
        </h3>
        <Users className="w-4 h-4 text-text-muted/50" />
      </div>
      <div className="space-y-3">
        {data.agents.map((agent) => (
          <div key={agent.agentType} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text capitalize">{agent.agentType}</span>
              <div className="flex items-center gap-3 text-xs text-text-muted">
                <span>{agent.taskCount} tasks</span>
                <span
                  className={cn(
                    "font-medium",
                    agent.successRate >= 80
                      ? "text-success"
                      : agent.successRate >= 50
                        ? "text-warning"
                        : "text-error",
                  )}
                >
                  {agent.successRate}%
                </span>
                <span className="tabular-nums">{formatCost(agent.avgCost)}</span>
              </div>
            </div>
            <div className="h-1.5 bg-bg-hover rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${(agent.taskCount / maxTasks) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
