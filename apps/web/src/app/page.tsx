"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { useDashboardData } from "@/hooks/use-dashboard-data";
import { RefreshCw, Plus } from "lucide-react";
import {
  UsagePanel,
  ClusterSummary,
  RecentActivity,
  PodsList,
  WelcomeHero,
  AgentComparison,
  NeedsYou,
  collectNeedsYou,
  RecentRuns,
  LimitsPanel,
  collectProviderLimits,
  SessionsBoard,
} from "@/components/dashboard";
import Link from "next/link";
import { useSessionsFeed } from "@/hooks/use-sessions-feed";
import { countSessions } from "@/lib/sessions-feed";
import { UpdateBanner } from "@/components/update-banner";

export default function OverviewPage() {
  usePageTitle("Overview");
  const {
    taskStats,
    recentTasks,
    repoCount,
    cluster,
    loading,
    usage,
    metricsAvailable,
    metricsHistory,
    localTerminals = [],
    localHosts = [],
    attentionTasks = [],
    recentRuns = [],
    refresh,
    refreshUsage,
  } = useDashboardData();
  const feed = useSessionsFeed();
  const counts = countSessions(feed.rows);

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
  // ── How far along am I on each agent subscription? ─────────────────
  const providerLimits = collectProviderLimits(usage, localHosts);

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
            {counts.running} running
            {counts.waiting > 0 && (
              <span className="text-success">
                {" \u00B7 "}
                {counts.waiting} waiting for you
              </span>
            )}
            {counts.needsYou > 0 && (
              <span className="text-warning">
                {" \u00B7 "}
                {counts.needsYou} need{counts.needsYou === 1 ? "s" : ""} you
              </span>
            )}
            {counts.recurring > 0 && (
              <span>
                {" \u00B7 "}
                {counts.recurring} recurring
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              refresh();
              feed.refetch();
            }}
            className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <Link
            href="/sessions/new"
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
          >
            <Plus className="w-4 h-4" /> New session
          </Link>
        </div>
      </div>

      <UpdateBanner />

      <NeedsYou items={needsYou} />

      <LimitsPanel
        providers={providerLimits}
        onRefresh={() => refreshUsage({ fresh: true })}
        onRefreshHosts={refresh}
      />

      <SessionsBoard rows={feed.rows} loading={feed.loading} />

      <AgentComparison />

      {/* UsagePanel now only carries the token-refresh banners; meters live in LimitsPanel. */}
      {(usage?.authFailures?.claude ||
        usage?.authFailures?.github ||
        usage?.hasRecentAuthFailure) && <UsagePanel usage={usage} onRefresh={refreshUsage} />}

      <ClusterSummary
        cluster={cluster}
        totalCost={totalCost}
        metricsAvailable={metricsAvailable}
        metricsHistory={metricsHistory}
      />

      <div className="[column-width:28rem] [column-gap:2rem] [&>*]:break-inside-avoid [&>*]:mb-8 [&>*:last-child]:mb-0">
        <RecentRuns runs={recentRuns.length > 0 ? recentRuns : []} />
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
