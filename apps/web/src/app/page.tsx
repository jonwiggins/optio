"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { useDashboardData } from "@/hooks/use-dashboard-data";
import { RefreshCw, GitPullRequest, Terminal, Bot, MessageSquare, Laptop } from "lucide-react";
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
  LocalSessions,
  NeedsYou,
  collectNeedsYou,
  QuietSections,
  type QuietSection,
} from "@/components/dashboard";
import {
  computeLocalStats,
  isLocalQuiet,
  recentLocalTerminals,
} from "@/components/dashboard/local-stats";
import { UpdateBanner } from "@/components/update-banner";

/** Section header used by every concept strip on the overview. */
function SectionLabel({ icon: Icon, children }: { icon: typeof Terminal; children: string }) {
  return (
    <div className="flex items-center gap-1.5 px-1">
      <Icon className="w-3 h-3 text-text-muted/60" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted/60">
        {children}
      </span>
    </div>
  );
}

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
    localTerminals = [],
    localHosts = [],
    attentionTasks = [],
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

  // Local sessions are a first-class way in: a machine paired and a
  // terminal open counts as "started", even with zero repo tasks.
  const isFirstRun = (taskStats?.total ?? 0) === 0 && localTerminals.length === 0;
  if (isFirstRun) {
    return <WelcomeHero repoCount={repoCount ?? 0} />;
  }

  // ── What needs me? ─────────────────────────────────────────────────
  const needsYou = collectNeedsYou(localTerminals, attentionTasks);

  // ── What's running? Each concept is either a full strip or one quiet line.
  const localStats =
    localHosts.length > 0 || localTerminals.length > 0
      ? computeLocalStats(localTerminals, localHosts)
      : null;
  const recentLocal = recentLocalTerminals(localTerminals);
  const localQuiet = isLocalQuiet(localStats, recentLocal);

  const standaloneLive = (standaloneStats?.running ?? 0) + (standaloneStats?.queued ?? 0) > 0;
  const agentsLive =
    (agentStats?.running ?? 0) + (agentStats?.queued ?? 0) + (agentStats?.paused ?? 0) > 0;
  const sessionsLive = (sessionStats?.active ?? 0) > 0;

  const quiet: QuietSection[] = [];
  if (localStats && localQuiet) {
    quiet.push({
      key: "local",
      label: "Local",
      href: "/local",
      icon: Laptop,
      summary:
        localStats.hostsOnline > 0
          ? `${localStats.hostsOnline} host${localStats.hostsOnline === 1 ? "" : "s"} online`
          : "no hosts online",
    });
  }
  if ((standaloneStats?.total ?? 0) > 0 && !standaloneLive) {
    quiet.push({
      key: "standalone",
      label: "Jobs",
      href: "/jobs",
      icon: Terminal,
      summary: `${standaloneStats?.completed ?? 0} done`,
    });
  }
  if ((agentStats?.total ?? 0) > 0 && !agentsLive) {
    quiet.push({
      key: "agents",
      label: "Persistent Agents",
      href: "/agents",
      icon: Bot,
      summary: `${agentStats?.idle ?? 0} idle`,
    });
  }
  if ((sessionStats?.total ?? 0) > 0 && !sessionsLive) {
    quiet.push({
      key: "sessions",
      label: "Sessions",
      href: "/sessions",
      icon: MessageSquare,
      summary: `${sessionStats?.ended ?? 0} ended today`,
    });
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

      <NeedsYou items={needsYou} />

      <div className="space-y-2">
        <SectionLabel icon={GitPullRequest}>Repo Tasks</SectionLabel>
        <PipelineStatsBar taskStats={taskStats} />
      </div>

      {localStats && !localQuiet && (
        <LocalSessions stats={localStats} terminals={recentLocal} hosts={localHosts} />
      )}

      {(standaloneStats?.total ?? 0) > 0 && standaloneLive && (
        <div className="space-y-2">
          <SectionLabel icon={Terminal}>Standalone Tasks</SectionLabel>
          <PipelineStatsBar variant="standalone" standaloneStats={standaloneStats} />
        </div>
      )}

      {(agentStats?.total ?? 0) > 0 && agentsLive && (
        <div className="space-y-2">
          <SectionLabel icon={Bot}>Persistent Agents</SectionLabel>
          <PipelineStatsBar variant="agents" agentStats={agentStats} />
        </div>
      )}

      {(sessionStats?.total ?? 0) > 0 && sessionsLive && (
        <div className="space-y-2">
          <SectionLabel icon={MessageSquare}>Sessions</SectionLabel>
          <PipelineStatsBar variant="sessions" sessionStats={sessionStats} />
        </div>
      )}

      <QuietSections sections={quiet} />

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
