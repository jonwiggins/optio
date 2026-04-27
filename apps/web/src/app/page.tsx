"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { useDashboardData } from "@/hooks/use-dashboard-data";
import { RefreshCw, GitPullRequest, Terminal, Bot, MessageSquare } from "lucide-react";
import {
  PipelineStatsBar,
  UsagePanel,
  ClusterSummary,
  ActiveSessions,
  RecentTasks,
  RecentActivity,
  PodsList,
  WelcomeHero,
  AgentComparison,
} from "@/components/dashboard";
import { UpdateBanner } from "@/components/update-banner";

export default function OverviewPage() {
  usePageTitle("Overview");
  const {
    taskStats,
    standaloneStats,
    agentStats,
    sessionStats,
    recentTasks,
    repoCount,
    cluster,
    loading,
    activeSessions,
    activeSessionCount,
    usage,
    metricsAvailable,
    metricsHistory,
    refresh,
    refreshUsage,
  } = useDashboardData();

  if (loading) {
    return (
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <div className="h-8 w-40 skeleton-shimmer" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 skeleton-shimmer" />
          ))}
        </div>
        <div className="h-16 skeleton-shimmer" />
        <div className="grid md:grid-cols-2 gap-8">
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-20 skeleton-shimmer" />
            ))}
          </div>
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-12 skeleton-shimmer" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const isFirstRun = (taskStats?.total ?? 0) === 0;
  if (isFirstRun) {
    return <WelcomeHero repoCount={repoCount ?? 0} />;
  }

  const totalCost = recentTasks.reduce((sum: number, t: any) => {
    return sum + (t.costUsd ? parseFloat(t.costUsd) : 0);
  }, 0);

  const {
    pods,
    events,
    repoPods: repoPodRecords,
  } = cluster ?? {
    pods: [],
    events: [],
    repoPods: [],
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6 stagger">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gradient">Overview</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {taskStats?.running ?? 0} active {(taskStats?.running ?? 0) === 1 ? "task" : "tasks"}
            {activeSessionCount > 0 && (
              <span className="text-primary">
                {" \u00B7 "}
                {activeSessionCount} {activeSessionCount === 1 ? "session" : "sessions"}
              </span>
            )}
            {(taskStats?.needsAttention ?? 0) > 0 && (
              <span className="text-warning">
                {" \u00B7 "}
                {taskStats?.needsAttention} need
                {(taskStats?.needsAttention ?? 0) === 1 ? "s" : ""} attention
              </span>
            )}
          </p>
        </div>
        <button
          onClick={refresh}
          className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <UpdateBanner />

      <div className="space-y-2">
        <div className="flex items-center gap-1.5 px-1">
          <GitPullRequest className="w-3 h-3 text-text-muted/60" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted/60">
            Repo Tasks
          </span>
        </div>
        <PipelineStatsBar taskStats={taskStats} />
      </div>

      {(standaloneStats?.total ?? 0) > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 px-1">
            <Terminal className="w-3 h-3 text-text-muted/60" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted/60">
              Standalone Tasks
            </span>
          </div>
          <PipelineStatsBar variant="standalone" standaloneStats={standaloneStats} />
        </div>
      )}

      {(agentStats?.total ?? 0) > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 px-1">
            <Bot className="w-3 h-3 text-text-muted/60" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted/60">
              Persistent Agents
            </span>
          </div>
          <PipelineStatsBar variant="agents" agentStats={agentStats} />
        </div>
      )}

      {(sessionStats?.total ?? 0) > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 px-1">
            <MessageSquare className="w-3 h-3 text-text-muted/60" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted/60">
              Sessions
            </span>
          </div>
          <PipelineStatsBar variant="sessions" sessionStats={sessionStats} />
        </div>
      )}

      <AgentComparison />

      <UsagePanel usage={usage} onRefresh={refreshUsage} />

      <ClusterSummary
        cluster={cluster}
        totalCost={totalCost}
        metricsAvailable={metricsAvailable}
        metricsHistory={metricsHistory}
      />

      <ActiveSessions sessions={activeSessions} activeCount={activeSessionCount} />

      <div className="[column-width:28rem] [column-gap:2rem] [&>*]:break-inside-avoid [&>*]:mb-8 [&>*:last-child]:mb-0">
        <RecentTasks tasks={recentTasks} />
        <PodsList
          pods={pods}
          events={events}
          recentTasks={recentTasks}
          repoPodRecords={repoPodRecords ?? []}
        />
        <RecentActivity />
      </div>
    </div>
  );
}
