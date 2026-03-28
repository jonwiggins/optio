"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import type { TaskStats, UsageData, MetricsHistoryPoint } from "@/components/dashboard/types.js";

const MAX_HISTORY = 60; // 10 minutes at 10s intervals

export function useDashboardData() {
  const [taskStats, setTaskStats] = useState<TaskStats | null>(null);
  const [recentTasks, setRecentTasks] = useState<any[]>([]);
  const [repoCount, setRepoCount] = useState<number | null>(null);
  const [cluster, setCluster] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeSessions, setActiveSessions] = useState<any[]>([]);
  const [activeSessionCount, setActiveSessionCount] = useState(0);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [metricsAvailable, setMetricsAvailable] = useState<boolean | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<MetricsHistoryPoint[]>([]);

  const refresh = useCallback(() => {
    Promise.all([
      api.listTasks({ limit: 100 }),
      api.getClusterOverview().catch(() => null),
      api.listRepos().catch(() => ({ repos: [] })),
      api
        .listSessions({ state: "active", limit: 5 })
        .catch(() => ({ sessions: [], activeCount: 0 })),
    ])
      .then(([tasksRes, clusterRes, reposRes, sessionsRes]) => {
        setActiveSessions(sessionsRes.sessions);
        setActiveSessionCount(sessionsRes.activeCount);
        const tasks = tasksRes.tasks;
        const prOpenedTasks = tasks.filter((t: any) => t.state === "pr_opened");
        const ciCount = prOpenedTasks.filter((t: any) => {
          const checks = t.prChecksStatus;
          const review = t.prReviewStatus;
          if (review && !["none", "pending"].includes(review)) return false;
          return !checks || ["none", "pending", "failing"].includes(checks);
        }).length;
        const reviewCount = prOpenedTasks.length - ciCount;
        setTaskStats({
          total: tasks.length,
          queued: tasks.filter((t: any) => ["pending", "queued", "provisioning"].includes(t.state))
            .length,
          running: tasks.filter((t: any) => t.state === "running").length,
          ci: ciCount,
          review: reviewCount,
          needsAttention: tasks.filter((t: any) => t.state === "needs_attention").length,
          failed: tasks.filter((t: any) => t.state === "failed").length,
          completed: tasks.filter((t: any) => t.state === "completed").length,
        });
        setRecentTasks(tasks.slice(0, 5));
        setRepoCount(reposRes.repos.length);
        if (clusterRes) {
          setCluster(clusterRes);
          setMetricsAvailable(clusterRes.metricsAvailable ?? null);
          const node = clusterRes.nodes?.[0];
          if (node) {
            const memPercent =
              node.memoryUsedGi != null && node.memoryTotalGi
                ? Math.round((parseFloat(node.memoryUsedGi) / parseFloat(node.memoryTotalGi)) * 100)
                : null;
            setMetricsHistory((prev) => {
              const next = [
                ...prev,
                {
                  time: Date.now(),
                  cpuPercent: node.cpuPercent ?? null,
                  memoryPercent: memPercent,
                  pods: clusterRes.summary?.totalPods ?? 0,
                  agents: clusterRes.summary?.agentPods ?? 0,
                },
              ];
              return next.slice(-MAX_HISTORY);
            });
          }
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const refreshUsage = useCallback(() => {
    api
      .getUsage()
      .then((res) => setUsage(res.usage))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    refreshUsage();
    const interval = setInterval(refresh, 10000);
    const usageInterval = setInterval(refreshUsage, 5 * 60 * 1000);
    return () => {
      clearInterval(interval);
      clearInterval(usageInterval);
    };
  }, [refresh, refreshUsage]);

  return {
    taskStats,
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
  };
}
