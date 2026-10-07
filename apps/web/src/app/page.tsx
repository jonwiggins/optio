"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { useDashboardData } from "@/hooks/use-dashboard-data";
import { LayoutDashboard, RefreshCw, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button, ButtonLink } from "@/components/ui/button";
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
  WorkBoard,
} from "@/components/dashboard";
import { useWorkFeed } from "@/hooks/use-work-feed";
import { countWork } from "@/lib/work-feed";
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
  const feed = useWorkFeed();
  const counts = countWork(feed.rows);

  if (loading) {
    return (
      <div className="page-column py-6 space-y-6">
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
    <div className="page-column py-6 space-y-6 stagger">
      <PageHeader
        icon={LayoutDashboard}
        title="Overview"
        meta={
          <span>
            {counts.running} running
            {counts.waiting > 0 && (
              <span className="text-success">
                {" \u00B7 "}
                {counts.waiting} waiting for you
              </span>
            )}
            {counts.needsYou > 0 && (
              <span className="text-success">
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
          </span>
        }
        actions={
          <>
            <Button
              variant="ghost"
              className="px-2"
              aria-label="Refresh"
              onClick={() => {
                refresh();
                feed.refetch();
              }}
            >
              <RefreshCw />
            </Button>
            <ButtonLink href="/work/new">
              <Plus /> New work
            </ButtonLink>
          </>
        }
      />

      <UpdateBanner />

      <NeedsYou items={needsYou} />

      <LimitsPanel
        providers={providerLimits}
        onRefresh={() => refreshUsage({ fresh: true })}
        onRefreshHosts={refresh}
      />

      <WorkBoard rows={feed.rows} loading={feed.loading} />

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
