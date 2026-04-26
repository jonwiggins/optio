"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Bot, Plus, MessageSquare, Pause, CircleDot, Archive } from "lucide-react";

const STATE_STYLES: Record<string, { dot: string; label: string }> = {
  idle: { dot: "bg-text-muted/50", label: "Idle" },
  queued: { dot: "bg-warning", label: "Queued" },
  provisioning: { dot: "bg-warning animate-pulse", label: "Provisioning" },
  running: { dot: "bg-primary animate-pulse", label: "Running" },
  paused: { dot: "bg-text-muted/30", label: "Paused" },
  failed: { dot: "bg-error", label: "Failed" },
  archived: { dot: "bg-text-muted/20", label: "Archived" },
};

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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Bot className="w-6 h-6 text-primary" />
            Persistent Agents
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Long-lived, named agents that wake on messages and events. Address them by slug from
            other agents, webhooks, or the chat below.
          </p>
        </div>
        <Link
          href="/agents/new"
          className="px-3 py-1.5 rounded-md bg-primary text-white text-sm hover:bg-primary-hover flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> New agent
        </Link>
      </div>

      {loading && agents.length === 0 ? (
        <div className="text-text-muted text-sm">Loading…</div>
      ) : agents.length === 0 ? (
        <div className="border border-border rounded-lg p-12 text-center">
          <Bot className="w-10 h-10 mx-auto text-text-muted mb-3" />
          <h2 className="text-lg font-medium">No persistent agents yet</h2>
          <p className="text-sm text-text-muted mt-1 max-w-md mx-auto">
            Create an agent that lives in your workspace, listens for messages and events, and wakes
            to do work.
          </p>
          <Link
            href="/agents/new"
            className="inline-flex mt-4 px-3 py-1.5 rounded-md bg-primary text-white text-sm hover:bg-primary-hover items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> Create your first agent
          </Link>
        </div>
      ) : (
        <div className="grid gap-3">
          {agents.map((agent) => {
            const style = STATE_STYLES[agent.state] ?? STATE_STYLES.idle;
            return (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}`}
                className="border border-border rounded-lg p-4 bg-bg-card hover:bg-bg-hover/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn("w-2 h-2 rounded-full", style.dot)} />
                      <span className="font-medium">{agent.name}</span>
                      <span className="text-xs text-text-muted font-mono">@{agent.slug}</span>
                    </div>
                    {agent.description ? (
                      <div className="text-sm text-text-muted mt-1 line-clamp-2">
                        {agent.description}
                      </div>
                    ) : null}
                  </div>
                  <div className="text-right text-xs text-text-muted shrink-0">
                    <div className="flex items-center gap-1.5 justify-end">
                      <span>{style.label}</span>
                      {agent.state === "paused" ? <Pause className="w-3 h-3" /> : null}
                      {agent.state === "archived" ? <Archive className="w-3 h-3" /> : null}
                    </div>
                    <div className="mt-0.5">{agent.agentRuntime}</div>
                    <div className="mt-0.5 capitalize">{agent.podLifecycle}</div>
                  </div>
                </div>
                <div className="flex items-center gap-4 mt-3 text-xs text-text-muted">
                  <span className="flex items-center gap-1">
                    <CircleDot className="w-3 h-3" />
                    {agent.lastTurnAt
                      ? `Last turn ${formatRelativeTime(agent.lastTurnAt)}`
                      : "Never run"}
                  </span>
                  <span>${Number(agent.totalCostUsd ?? 0).toFixed(4)}</span>
                  {agent.consecutiveFailures > 0 ? (
                    <span className="text-error">⚠ {agent.consecutiveFailures} failures</span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-1">
                    <MessageSquare className="w-3 h-3" />
                    Open
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
