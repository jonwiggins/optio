"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { formatRelativeTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusDot } from "@/components/status-dot";
import { Bot, Plus, MessageSquare, Pause, CircleDot, Archive } from "lucide-react";

interface Agent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  state: string;
  agentRuntime: string;
  podLifecycle: string;
  enabled: boolean;
  totalCostUsd: string;
  consecutiveFailures: number;
  lastTurnAt: string | null;
  updatedAt: string;
}

const STATE_LABEL: Record<string, string> = {
  idle: "Idle",
  queued: "Queued",
  provisioning: "Provisioning",
  running: "Running",
  paused: "Paused",
  failed: "Failed",
  archived: "Archived",
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    api
      .listPersistentAgents()
      .then((res) => setAgents(res.agents as Agent[]))
      .catch(() => toast.error("Failed to load agents"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        icon={Bot}
        title="Agents"
        description="Long-lived agents that wake on messages and events. Address them by slug from other agents, webhooks, or the chat below."
        actions={
          <Link
            href="/agents/new"
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
          >
            <Plus className="w-4 h-4" />
            New agent
          </Link>
        }
      />

      {loading && agents.length === 0 ? (
        <div className="text-text-muted text-sm">Loading…</div>
      ) : agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="Create an agent that lives in your workspace, listens for messages and events, and wakes to do work."
          action={
            <Link
              href="/agents/new"
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
            >
              <Plus className="w-4 h-4" /> Create your first agent
            </Link>
          }
        />
      ) : (
        <div className="grid gap-2">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="card-hover block rounded-lg border border-border bg-bg-card hover:border-primary/30 px-4 py-3"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StatusDot state={agent.state} />
                    <span className="font-medium text-text-heading">{agent.name}</span>
                    <span className="text-xs text-text-muted/80 font-mono">@{agent.slug}</span>
                  </div>
                  {agent.description ? (
                    <div className="text-sm text-text-muted mt-1 line-clamp-2">
                      {agent.description}
                    </div>
                  ) : null}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-text-muted flex items-center gap-1.5 justify-end">
                    <span>{STATE_LABEL[agent.state] ?? agent.state}</span>
                    {agent.state === "paused" ? <Pause className="w-3 h-3" /> : null}
                    {agent.state === "archived" ? <Archive className="w-3 h-3" /> : null}
                  </div>
                  <div className="text-[11px] text-text-muted/70 font-mono mt-1">
                    {agent.agentRuntime} · {agent.podLifecycle}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4 mt-2.5 text-[11px] text-text-muted/80">
                <span className="flex items-center gap-1.5">
                  <CircleDot className="w-3 h-3" />
                  {agent.lastTurnAt
                    ? `Last turn ${formatRelativeTime(agent.lastTurnAt)}`
                    : "Never run"}
                </span>
                <span className="font-mono">${Number(agent.totalCostUsd ?? 0).toFixed(4)}</span>
                {agent.consecutiveFailures > 0 ? (
                  <span className="text-error">⚠ {agent.consecutiveFailures} failures</span>
                ) : null}
                <span className="ml-auto flex items-center gap-1 text-text-muted/60">
                  <MessageSquare className="w-3 h-3" />
                  Open
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
