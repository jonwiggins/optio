"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import type {
  TaskStats,
  StandaloneStats,
  PersistentAgentStats,
  SessionStats,
  UsageData,
  MetricsHistoryPoint,
} from "@/components/dashboard/types.js";

const MAX_HISTORY = 60; // 10 minutes at 10s intervals

export function useDashboardData() {
  const [taskStats, setTaskStats] = useState<TaskStats | null>(null);
  const [standaloneStats, setStandaloneStats] = useState<StandaloneStats | null>(null);
  const [agentStats, setAgentStats] = useState<PersistentAgentStats | null>(null);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
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
      api.getTaskStats(),
      api.listTasks({ limit: 5 }),
      api.getClusterOverview().catch(() => null),
      api.listRepos().catch(() => ({ repos: [] })),
      api
        .listSessions({ state: "active", limit: 5 })
        .catch(() => ({ sessions: [], activeCount: 0 })),
      api.getJobStats().catch(() => null),
      api.getPersistentAgentStats().catch(() => null),
      api.getSessionStats().catch(() => null),
    ])
      .then(
        ([
          statsRes,
          tasksRes,
          clusterRes,
          reposRes,
          sessionsRes,
          jobStatsRes,
          agentStatsRes,
          sessionStatsRes,
        ]) => {
          setActiveSessions(sessionsRes.sessions);
          setActiveSessionCount(sessionsRes.activeCount);
          setTaskStats(statsRes.stats);
          setStandaloneStats(jobStatsRes?.stats ?? null);
          setAgentStats(agentStatsRes?.stats ?? null);
          setSessionStats(sessionStatsRes?.stats ?? null);
          setRecentTasks(tasksRes.tasks);
          setRepoCount(reposRes.repos.length);
          if (clusterRes) {
            setCluster(clusterRes);
            setMetricsAvailable(clusterRes.metricsAvailable ?? null);
            const node = clusterRes.nodes?.[0];
            if (node) {
              const memPercent =
                node.memoryUsedGi != null && node.memoryTotalGi
                  ? Math.round(
                      (parseFloat(node.memoryUsedGi) / parseFloat(node.memoryTotalGi)) * 100,
                    )
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
        },
      )
      .finally(() => setLoading(false));
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      const res = await api.getUsage();
      if (!res.usage.available && !res.usage.error) {
        // Usage unavailable without error — check if token is expired
        const authRes = await api.getAuthStatus().catch(() => null);
        if (authRes?.subscription.expired) {
          setUsage({ available: false, error: "OAuth token has expired" });
          return;
        }
      }
      setUsage(res.usage);
    } catch {
      // If usage endpoint itself fails, check auth status
      try {
        const authRes = await api.getAuthStatus();
        if (authRes.subscription.expired) {
          setUsage({ available: false, error: "OAuth token has expired" });
        }
      } catch {}
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshUsage();
    const interval = setInterval(refresh, 10000);
    const usageInterval = setInterval(refreshUsage, 5 * 60 * 1000);

    // Listen for auth:failed WebSocket events (dispatched via DOM event from use-websocket)
    // to immediately show the token renewal widget instead of waiting for the polling interval
    const onAuthFailed = () => {
      setUsage({ available: false, error: "OAuth token has expired" });
    };
    window.addEventListener("optio:auth-failed", onAuthFailed);

    // Listen for auth:status_changed (token updated via secrets page) to immediately
    // re-fetch usage so the banner disappears as soon as the watermark moves forward
    const onAuthStatusChanged = () => {
      refreshUsage();
    };
    window.addEventListener("optio:auth-status-changed", onAuthStatusChanged);

    return () => {
      clearInterval(interval);
      clearInterval(usageInterval);
      window.removeEventListener("optio:auth-failed", onAuthFailed);
      window.removeEventListener("optio:auth-status-changed", onAuthStatusChanged);
    };
  }, [refresh, refreshUsage]);

  return {
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
  };
}
