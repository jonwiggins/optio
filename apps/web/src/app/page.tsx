"use client";

import { useEffect, useState } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { TaskCard } from "@/components/task-card";
import Link from "next/link";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Loader2,
  Activity,
  CheckCircle,
  AlertTriangle,
  GitPullRequest,
  Circle,
  Cpu,
  HardDrive,
  RefreshCw,
  Container,
  Database,
  ChevronDown,
  ChevronUp,
  X,
  Plus,
  DollarSign,
  BarChart3,
  Gauge,
  Clock,
  Zap,
  FolderGit2,
  ListTodo,
  ArrowRight,
  Rocket,
  KeyRound,
  GitBranch,
  Bot,
  Terminal,
  CircleDot,
} from "lucide-react";
import { StateBadge } from "@/components/state-badge";

const STATUS_COLORS: Record<string, string> = {
  Running: "text-success",
  Ready: "text-success",
  ready: "text-success",
  Succeeded: "text-text-muted",
  Pending: "text-warning",
  provisioning: "text-warning",
  ImagePullBackOff: "text-error",
  ErrImagePull: "text-error",
  CrashLoopBackOff: "text-error",
  Error: "text-error",
  error: "text-error",
  Failed: "text-error",
  failed: "text-error",
  NotReady: "text-error",
  Unknown: "text-text-muted",
};

function formatK8sResource(value: string | undefined): string {
  if (!value) return "\u2014";
  const kiMatch = value.match(/^(\d+)Ki$/);
  if (kiMatch) {
    const ki = parseInt(kiMatch[1], 10);
    if (ki >= 1048576) return `${(ki / 1048576).toFixed(1)} Gi`;
    if (ki >= 1024) return `${(ki / 1024).toFixed(0)} Mi`;
    return `${ki} Ki`;
  }
  const miMatch = value.match(/^(\d+)Mi$/);
  if (miMatch) {
    const mi = parseInt(miMatch[1], 10);
    if (mi >= 1024) return `${(mi / 1024).toFixed(1)} Gi`;
    return `${mi} Mi`;
  }
  const giMatch = value.match(/^(\d+)Gi$/);
  if (giMatch) return `${giMatch[1]} Gi`;
  const bytes = parseInt(value, 10);
  if (!isNaN(bytes)) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} Gi`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} Mi`;
  }
  return value;
}

interface TaskStats {
  total: number;
  running: number;
  needsAttention: number;
  prOpened: number;
  completed: number;
  failed: number;
}

export default function OverviewPage() {
  usePageTitle("Overview");
  const [taskStats, setTaskStats] = useState<TaskStats | null>(null);
  const [recentTasks, setRecentTasks] = useState<any[]>([]);
  const [repoCount, setRepoCount] = useState<number | null>(null);
  const [cluster, setCluster] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [activeSessions, setActiveSessions] = useState<any[]>([]);
  const [activeSessionCount, setActiveSessionCount] = useState(0);
  const [dismissedEvents, setDismissedEvents] = useState<Set<number>>(new Set());
  const [expandedPods, setExpandedPods] = useState<Set<string>>(new Set());
  const [usage, setUsage] = useState<{
    available: boolean;
    fiveHour?: { utilization: number | null; resetsAt: string | null };
    sevenDay?: { utilization: number | null; resetsAt: string | null };
    sevenDaySonnet?: { utilization: number | null; resetsAt: string | null };
    sevenDayOpus?: { utilization: number | null; resetsAt: string | null };
  } | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const [metricsAvailable, setMetricsAvailable] = useState<boolean | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<
    {
      time: number;
      cpuPercent: number | null;
      memoryPercent: number | null;
      pods: number;
      agents: number;
    }[]
  >([]);
  const MAX_HISTORY = 60; // 10 minutes at 10s intervals

  const refresh = () => {
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
        setTaskStats({
          total: tasks.length,
          running: tasks.filter((t: any) => t.state === "running").length,
          needsAttention: tasks.filter((t: any) => t.state === "needs_attention").length,
          prOpened: tasks.filter((t: any) => t.state === "pr_opened").length,
          completed: tasks.filter((t: any) => t.state === "completed").length,
          failed: tasks.filter((t: any) => t.state === "failed").length,
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
  };

  const refreshUsage = () => {
    api
      .getUsage()
      .then((res) => setUsage(res.usage))
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    refreshUsage();
    const interval = setInterval(refresh, 10000);
    const usageInterval = setInterval(refreshUsage, 5 * 60 * 1000);
    return () => {
      clearInterval(interval);
      clearInterval(usageInterval);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
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
    nodes,
    pods,
    events,
    summary,
    repoPods: repoPodRecords,
  } = cluster ?? {
    nodes: [],
    pods: [],
    services: [],
    events: [],
    summary: {
      totalPods: 0,
      runningPods: 0,
      agentPods: 0,
      infraPods: 0,
      totalNodes: 0,
      readyNodes: 0,
    },
    repoPods: [],
  };

  const repoPodByName = new Map<string, any>(
    (repoPodRecords ?? []).map((rp: any) => [rp.podName, rp]),
  );

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
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
          className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={Activity}
          label="Running"
          value={taskStats?.running ?? 0}
          color="text-primary"
        />
        <StatCard
          icon={AlertTriangle}
          label="Attention"
          value={taskStats?.needsAttention ?? 0}
          color="text-warning"
        />
        <StatCard
          icon={GitPullRequest}
          label="PRs Open"
          value={taskStats?.prOpened ?? 0}
          color="text-success"
        />
        <StatCard
          icon={CheckCircle}
          label="Completed"
          value={taskStats?.completed ?? 0}
          color="text-success"
        />
      </div>

      {usage?.available && (
        <div className="rounded-xl border border-border/50 bg-bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Gauge className="w-3.5 h-3.5 text-text-muted" />
            <span className="text-xs font-medium text-text-heading">Claude Max Usage</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {usage.fiveHour && usage.fiveHour.utilization != null && (
              <UsageMeter
                label="5-hour"
                utilization={usage.fiveHour.utilization}
                resetsAt={usage.fiveHour.resetsAt}
              />
            )}
            {usage.sevenDay && usage.sevenDay.utilization != null && (
              <UsageMeter
                label="7-day"
                utilization={usage.sevenDay.utilization}
                resetsAt={usage.sevenDay.resetsAt}
              />
            )}
            {usage.sevenDaySonnet && usage.sevenDaySonnet.utilization != null && (
              <UsageMeter
                label="7d Sonnet"
                utilization={usage.sevenDaySonnet.utilization}
                resetsAt={usage.sevenDaySonnet.resetsAt}
              />
            )}
            {usage.sevenDayOpus && usage.sevenDayOpus.utilization != null && (
              <UsageMeter
                label="7d Opus"
                utilization={usage.sevenDayOpus.utilization}
                resetsAt={usage.sevenDayOpus.resetsAt}
              />
            )}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border/50 bg-bg-card overflow-hidden">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-4 text-xs">
            {nodes[0] && (
              <span className="flex items-center gap-1.5 text-text-muted font-mono border-r border-border pr-4 mr-1">
                {nodes[0].name} <span className="text-text-muted/50">/ optio</span>
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Circle
                className={cn(
                  "w-2 h-2 fill-current",
                  summary.readyNodes > 0 ? "text-success" : "text-error",
                )}
              />
              <span className="text-text-muted">Nodes</span>
              <span className="font-medium">
                {summary.readyNodes}/{summary.totalNodes}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <Container className="w-3 h-3 text-text-muted" />
              <span className="text-text-muted">Pods</span>
              <span className="font-medium">
                {summary.runningPods}/{summary.totalPods}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <Activity className="w-3 h-3 text-text-muted" />
              <span className="text-text-muted">Agents</span>
              <span className="font-medium">{summary.agentPods}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Database className="w-3 h-3 text-text-muted" />
              <span className="text-text-muted">Infra</span>
              <span className="font-medium">{summary.infraPods}</span>
            </span>
          </div>
          {nodes[0] && (
            <div className="flex items-center gap-3 text-[11px] text-text-muted">
              <span className="flex items-center gap-1">
                <Cpu className="w-3 h-3" />
                {nodes[0].cpuPercent != null ? (
                  <>
                    <span className="font-medium text-text">{nodes[0].cpuPercent}%</span> of{" "}
                    {nodes[0].cpu} cores
                  </>
                ) : (
                  <>
                    <span className="font-medium text-text-muted/50">N/A</span> · {nodes[0].cpu}{" "}
                    cores
                  </>
                )}
              </span>
              <span className="flex items-center gap-1">
                <HardDrive className="w-3 h-3" />
                {nodes[0].memoryUsedGi != null ? (
                  <>
                    <span className="font-medium text-text">{nodes[0].memoryUsedGi}</span> /{" "}
                    {nodes[0].memoryTotalGi} Gi
                  </>
                ) : (
                  <>
                    <span className="font-medium text-text-muted/50">N/A</span> ·{" "}
                    {formatK8sResource(nodes[0].memory)}
                  </>
                )}
              </span>
              {totalCost > 0 && (
                <span className="flex items-center gap-1 border-l border-border pl-3 ml-1">
                  <DollarSign className="w-3 h-3" />
                  <span className="font-medium text-text">${totalCost.toFixed(2)}</span>
                  <span className="text-text-muted">total</span>
                </span>
              )}
              <button
                onClick={() => setShowMetrics(!showMetrics)}
                className="flex items-center gap-1 ml-2 pl-3 border-l border-border text-text-muted hover:text-text transition-colors"
              >
                <BarChart3 className="w-3 h-3" />
                {showMetrics ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </button>
            </div>
          )}
        </div>

        {showMetrics && (
          <div className="border-t border-border/30 px-4 py-4">
            {metricsAvailable === false ? (
              <div className="text-xs text-text-muted/50 text-center py-3">
                metrics-server not detected — CPU and memory charts unavailable.
                <br />
                <span className="text-[10px]">
                  Install with: kubectl apply -f
                  https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
                </span>
              </div>
            ) : metricsHistory.length > 1 ? (
              <>
                <div className="grid grid-cols-3 gap-6">
                  <MiniChart
                    label="CPU"
                    data={metricsHistory.map((m) => m.cpuPercent ?? 0)}
                    suffix="%"
                    color="var(--color-primary)"
                    max={100}
                  />
                  <MiniChart
                    label="Memory"
                    data={metricsHistory.map((m) => m.memoryPercent ?? 0)}
                    suffix="%"
                    color="var(--color-info)"
                    max={100}
                  />
                  <MiniChart
                    label="Pods"
                    data={metricsHistory.map((m) => m.pods)}
                    suffix=""
                    color="var(--color-success)"
                  />
                </div>
                <div className="text-[10px] text-text-muted/40 mt-2 text-right">
                  {metricsHistory.length} samples · refreshing every 10s
                </div>
              </>
            ) : (
              <div className="text-xs text-text-muted/50 text-center py-3">
                Collecting metrics data... graphs will appear in a few seconds.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Active Sessions */}
      {activeSessions.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-text-heading flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              Active Sessions
              <span className="text-xs font-normal text-primary bg-primary/10 px-1.5 py-0.5 rounded-md">
                {activeSessionCount}
              </span>
            </h2>
            <Link href="/sessions" className="text-xs text-primary hover:underline">
              All sessions &rarr;
            </Link>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
            {activeSessions.map((session: any) => {
              const repoName = session.repoUrl
                ? session.repoUrl.replace("https://github.com/", "")
                : "Unknown";
              return (
                <Link
                  key={session.id}
                  href={`/sessions/${session.id}`}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg-card hover:border-primary/30 hover:bg-bg-hover transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Terminal className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium truncate">
                        {session.branch ?? `Session ${session.id.slice(0, 8)}`}
                      </span>
                      <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse shrink-0" />
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-text-muted mt-0.5">
                      <span className="flex items-center gap-0.5">
                        <FolderGit2 className="w-2.5 h-2.5" />
                        {repoName}
                      </span>
                      <span>{formatRelativeTime(session.createdAt)}</span>
                    </div>
                  </div>
                  <CircleDot className="w-3.5 h-3.5 text-primary shrink-0" />
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-8">
        <div className="min-w-0 overflow-hidden">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-text-heading">Recent Tasks</h2>
            <div className="flex items-center gap-2">
              <Link
                href="/tasks/new"
                className="text-xs text-primary hover:underline flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> New
              </Link>
              <Link href="/tasks" className="text-xs text-primary hover:underline">
                All &rarr;
              </Link>
            </div>
          </div>
          {recentTasks.length === 0 ? (
            <EmptyState
              icon={ListTodo}
              title="No tasks yet"
              description="Create your first task to get an AI agent working on your code."
              action={{ label: "Create a task", href: "/tasks/new" }}
            />
          ) : (
            <div className="grid gap-2">
              {recentTasks.map((task: any) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0 overflow-hidden">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-text-heading">Pods</h2>
          </div>
          {pods.length === 0 ? (
            <EmptyState
              icon={Container}
              title="No pods running"
              description="Pods are created automatically when tasks start. They stay warm for fast iteration."
            />
          ) : (
            <div className="space-y-1.5">
              {pods.map((pod: any) => {
                const color = STATUS_COLORS[pod.status] ?? "text-text-muted";
                const isExpanded = expandedPods.has(pod.name);
                const podTasks = pod.isOptioManaged
                  ? recentTasks.filter((t: any) => t.containerId === pod.name)
                  : [];
                const repoPod = pod.isOptioManaged ? repoPodByName.get(pod.name) : null;

                return (
                  <div key={pod.name} className="rounded-md border border-border bg-bg-card">
                    <button
                      onClick={() => {
                        if (!pod.isOptioManaged) return;
                        setExpandedPods((prev) => {
                          const next = new Set(prev);
                          if (next.has(pod.name)) next.delete(pod.name);
                          else next.add(pod.name);
                          return next;
                        });
                      }}
                      className={cn(
                        "w-full text-left p-2.5",
                        pod.isOptioManaged && "cursor-pointer hover:bg-bg-hover",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Circle className={cn("w-2 h-2 fill-current shrink-0", color)} />
                        <span className="font-mono text-xs font-medium truncate">{pod.name}</span>
                        {pod.isOptioManaged && (
                          <>
                            <span className="text-[9px] px-1 py-0.5 rounded bg-primary/10 text-primary">
                              workspace
                            </span>
                            {repoPod && <CapacityIndicator repoPod={repoPod} />}
                            <ChevronDown
                              className={cn(
                                "w-3 h-3 text-text-muted ml-auto shrink-0 transition-transform",
                                isExpanded && "rotate-180",
                              )}
                            />
                          </>
                        )}
                        {pod.isInfra && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-info/10 text-info">
                            infra
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-text-muted mt-1 ml-4">
                        <span className={color}>{pod.status}</span>
                        {repoPod && (
                          <>
                            <span className="flex items-center gap-0.5">
                              <Activity className="w-2.5 h-2.5" />
                              {repoPod.activeTaskCount ?? 0} running
                            </span>
                            {(repoPod.queuedTaskCount ?? 0) > 0 && (
                              <span className="flex items-center gap-0.5 text-warning">
                                <Clock className="w-2.5 h-2.5" />
                                {repoPod.queuedTaskCount} queued
                              </span>
                            )}
                          </>
                        )}
                        {pod.cpuMillicores != null && (
                          <span className="flex items-center gap-0.5">
                            <Cpu className="w-2.5 h-2.5" />
                            {pod.cpuMillicores}m
                          </span>
                        )}
                        {pod.memoryMi != null && (
                          <span className="flex items-center gap-0.5">
                            <HardDrive className="w-2.5 h-2.5" />
                            {pod.memoryMi} Mi
                          </span>
                        )}
                        {pod.restarts > 0 && (
                          <span className="text-warning">{pod.restarts} restarts</span>
                        )}
                        <span className="font-mono">{pod.image?.split("/").pop()}</span>
                        {pod.startedAt && <span>{formatRelativeTime(pod.startedAt)}</span>}
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="border-t border-border px-2.5 py-2 space-y-1">
                        {podTasks.length > 0 ? (
                          podTasks.map((t: any) => (
                            <Link
                              key={t.id}
                              href={`/tasks/${t.id}`}
                              className="flex items-center justify-between p-1.5 rounded hover:bg-bg-hover text-xs"
                            >
                              <span className="truncate">{t.title}</span>
                              <StateBadge state={t.state} />
                            </Link>
                          ))
                        ) : (
                          <div className="text-[10px] text-text-muted py-1">No recent tasks</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {events.filter((_: any, i: number) => !dismissedEvents.has(i)).length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-medium text-text-muted">Recent Events</h3>
                {dismissedEvents.size < events.length && (
                  <button
                    onClick={() =>
                      setDismissedEvents(new Set(events.map((_: any, i: number) => i)))
                    }
                    className="text-[10px] text-text-muted hover:text-text"
                  >
                    Dismiss all
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {events.slice(0, 8).map((event: any, i: number) => {
                  if (dismissedEvents.has(i)) return null;
                  return (
                    <div key={i} className="p-2.5 rounded-md border border-border bg-bg-card group">
                      <div className="flex items-center gap-2">
                        <AlertTriangle
                          className={cn(
                            "w-3 h-3 shrink-0",
                            event.type === "Warning" ? "text-warning" : "text-info",
                          )}
                        />
                        <span className="text-xs font-medium">{event.reason}</span>
                        <span className="text-[10px] text-text-muted font-mono">
                          {event.involvedObject}
                        </span>
                        {event.count > 1 && (
                          <span className="text-[10px] text-text-muted">x{event.count}</span>
                        )}
                        <span className="flex-1" />
                        {event.lastTimestamp && (
                          <span className="text-[10px] text-text-muted/50">
                            {formatRelativeTime(event.lastTimestamp)}
                          </span>
                        )}
                        <button
                          onClick={() => setDismissedEvents((prev) => new Set([...prev, i]))}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-hover text-text-muted transition-opacity"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                      <p className="text-[10px] text-text-muted mt-1 ml-5 truncate">
                        {event.message}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* --- Welcome Hero --- */

function WelcomeHero({ repoCount }: { repoCount: number }) {
  const hasRepos = repoCount > 0;

  const steps = [
    {
      num: 1,
      icon: KeyRound,
      title: "Configure secrets",
      description: "Add your Anthropic API key or connect Claude Max credentials.",
      href: "/secrets",
      done: false,
    },
    {
      num: 2,
      icon: FolderGit2,
      title: "Add a repository",
      description: "Connect a GitHub repo so Optio can clone it and run agents.",
      href: "/repos/new",
      done: hasRepos,
    },
    {
      num: 3,
      icon: Rocket,
      title: "Create your first task",
      description: "Describe what you want built. Optio spins up an agent and opens a PR.",
      href: "/tasks/new",
      done: false,
    },
  ];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="relative overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-br from-bg-card via-bg-card to-primary/[0.04] px-8 py-12 mb-8">
        <div className="absolute top-0 right-0 w-72 h-72 bg-primary/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-primary/3 rounded-full blur-3xl translate-y-1/2 -translate-x-1/4" />

        <div className="relative">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-xl bg-primary/10 border border-primary/20">
              <Zap className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Welcome to Optio</h1>
          </div>
          <p className="text-text-muted text-lg max-w-xl leading-relaxed mb-2">
            CI/CD where the build step is an AI agent. Submit tasks from the dashboard or GitHub
            Issues, and Optio handles the rest &mdash; isolated pods, code generation, and pull
            requests.
          </p>

          <div className="flex items-center gap-4 mt-6 text-sm text-text-muted">
            <span className="flex items-center gap-1.5">
              <Bot className="w-4 h-4 text-primary" />
              AI-powered coding
            </span>
            <span className="flex items-center gap-1.5">
              <GitBranch className="w-4 h-4 text-primary" />
              Auto PR creation
            </span>
            <span className="flex items-center gap-1.5">
              <Container className="w-4 h-4 text-primary" />
              Isolated K8s pods
            </span>
          </div>
        </div>
      </div>

      <div className="mb-8">
        <h2 className="text-sm font-medium text-text-heading uppercase tracking-wider mb-4">
          Get started
        </h2>
        <div className="grid gap-3">
          {steps.map((step) => (
            <Link
              key={step.num}
              href={step.href}
              className={cn(
                "group flex items-center gap-4 p-4 rounded-xl border transition-all",
                step.done
                  ? "border-success/20 bg-success/[0.03]"
                  : "border-border/50 bg-bg-card hover:border-primary/30 hover:bg-bg-card-hover",
              )}
            >
              <div
                className={cn(
                  "flex items-center justify-center w-10 h-10 rounded-lg shrink-0",
                  step.done
                    ? "bg-success/10 text-success"
                    : "bg-bg-hover text-text-muted group-hover:bg-primary/10 group-hover:text-primary",
                )}
              >
                {step.done ? (
                  <CheckCircle className="w-5 h-5" />
                ) : (
                  <step.icon className="w-5 h-5" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-sm font-medium",
                      step.done ? "text-success" : "text-text-heading",
                    )}
                  >
                    {step.title}
                  </span>
                  {step.done && (
                    <span className="text-[10px] font-medium text-success bg-success/10 px-1.5 py-0.5 rounded">
                      Done
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-0.5">{step.description}</p>
              </div>
              <ArrowRight
                className={cn(
                  "w-4 h-4 shrink-0 transition-transform",
                  step.done
                    ? "text-success/40"
                    : "text-text-muted/30 group-hover:text-primary group-hover:translate-x-0.5",
                )}
              />
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <QuickLink icon={ListTodo} label="Tasks" description="View all tasks" href="/tasks" />
        <QuickLink
          icon={FolderGit2}
          label="Repos"
          description="Manage repositories"
          href="/repos"
        />
        <QuickLink
          icon={Container}
          label="Cluster"
          description="K8s pods & nodes"
          href="/cluster"
        />
        <QuickLink
          icon={KeyRound}
          label="Secrets"
          description="API keys & tokens"
          href="/secrets"
        />
      </div>
    </div>
  );
}

function QuickLink({
  icon: Icon,
  label,
  description,
  href,
}: {
  icon: any;
  label: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group p-4 rounded-xl border border-border/50 bg-bg-card hover:border-primary/30 hover:bg-bg-card-hover transition-all"
    >
      <Icon className="w-5 h-5 text-text-muted group-hover:text-primary transition-colors mb-2" />
      <div className="text-sm font-medium text-text-heading">{label}</div>
      <div className="text-xs text-text-muted mt-0.5">{description}</div>
    </Link>
  );
}

/* --- Reusable Empty State --- */

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: any;
  title: string;
  description: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 rounded-xl border border-dashed border-border bg-bg-card/50">
      <div className="p-3.5 rounded-2xl bg-bg-hover/70 mb-4">
        <Icon className="w-7 h-7 text-text-muted/60" />
      </div>
      <span className="text-sm font-medium text-text-heading">{title}</span>
      <p className="text-xs text-text-muted mt-1.5 text-center max-w-xs leading-relaxed">
        {description}
      </p>
      {action && (
        <Link
          href={action.href}
          className="mt-5 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors shadow-sm"
        >
          <Plus className="w-3.5 h-3.5" />
          {action.label}
        </Link>
      )}
    </div>
  );
}

/* --- Helper Components --- */

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: any;
  label: string;
  value: number;
  color: string;
}) {
  const accentMap: Record<string, string> = {
    "text-primary": "border-l-primary/40",
    "text-warning": "border-l-warning/40",
    "text-success": "border-l-success/40",
    "text-error": "border-l-error/40",
    "text-info": "border-l-info/40",
  };
  const accent = accentMap[color] ?? "border-l-primary/40";

  return (
    <div
      className={cn(
        "p-4 rounded-xl border border-border/50 bg-bg-card relative overflow-hidden border-l-2 hover:bg-bg-card-hover transition-colors",
        accent,
      )}
    >
      <Icon className={cn("w-8 h-8 absolute top-3 right-3 opacity-15", color)} />
      <span className="text-xs font-medium uppercase tracking-wider text-text-muted">{label}</span>
      <div className="mt-1.5">
        <span className={cn("text-3xl font-semibold tabular-nums", value > 0 && color)}>
          {value}
        </span>
      </div>
    </div>
  );
}

function UsageMeter({
  label,
  utilization,
  resetsAt,
}: {
  label: string;
  utilization: number;
  resetsAt: string | null;
}) {
  const pct = Math.min(utilization, 100);
  const color = pct >= 80 ? "bg-error" : pct >= 50 ? "bg-warning" : "bg-primary";
  const textColor = pct >= 80 ? "text-error" : pct >= 50 ? "text-warning" : "text-primary";

  let resetLabel: string | null = null;
  if (resetsAt) {
    const diff = new Date(resetsAt).getTime() - Date.now();
    if (diff > 0) {
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      resetLabel = h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-text-muted">{label}</span>
        <span className={cn("text-[11px] font-medium tabular-nums", textColor)}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-border/50 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {resetLabel && (
        <div className="flex items-center gap-1 mt-1">
          <Clock className="w-2.5 h-2.5 text-text-muted/50" />
          <span className="text-[10px] text-text-muted/50">resets in {resetLabel}</span>
        </div>
      )}
    </div>
  );
}

function CapacityIndicator({ repoPod }: { repoPod: any }) {
  const active = repoPod.activeTaskCount ?? 0;
  const max = repoPod.maxAgentsPerPod ?? repoPod.maxConcurrentTasks ?? 2;
  const pct = max > 0 ? Math.min((active / max) * 100, 100) : 0;
  const color = pct >= 100 ? "bg-error" : pct >= 50 ? "bg-warning" : "bg-success";

  return (
    <span className="flex items-center gap-1.5 text-[9px] text-text-muted tabular-nums">
      <span className="h-1.5 w-10 rounded-full bg-border/50 overflow-hidden inline-block">
        <span
          className={cn("h-full rounded-full block transition-all", color)}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span>
        {active}/{max}
      </span>
    </span>
  );
}

function MiniChart({
  label,
  data,
  suffix,
  color,
  max: fixedMax,
}: {
  label: string;
  data: number[];
  suffix: string;
  color: string;
  max?: number;
}) {
  if (data.length < 2) return null;
  const current = data[data.length - 1];
  const max = fixedMax ?? Math.max(...data, 1);
  const min = fixedMax != null ? 0 : Math.min(...data);
  const range = max - min || 1;

  const w = 240;
  const h = 48;
  const points = data.map((v, i) => ({
    x: (i / (data.length - 1)) * w,
    y: h - ((v - min) / range) * h,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaPath = `${linePath} L ${w} ${h} L 0 ${h} Z`;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-text-muted">{label}</span>
        <span className="text-[11px] font-medium tabular-nums">
          {current}
          {suffix}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-12" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#grad-${label})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r="2.5"
          fill={color}
        />
      </svg>
    </div>
  );
}
