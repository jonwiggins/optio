"use client";

import { useEffect, useState, useCallback } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { cn, formatRelativeTime } from "@/lib/utils";
import Link from "next/link";
import {
  Activity,
  RefreshCw,
  User,
  Zap,
  Server,
  ChevronDown,
  ChevronRight,
  ListTodo,
  FolderGit2,
  GitBranch,
  Plug,
  KeyRound,
  Webhook,
  Terminal,
  Settings,
  Shield,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { StatTile } from "@/components/ui/stat-tile";

type ActivityItem = {
  id: string;
  type: "action" | "task_event" | "auth_event" | "infra_event";
  timestamp: string;
  actor?: { id: string; displayName: string; avatarUrl?: string | null } | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  summary: string;
  details?: Record<string, unknown> | null;
};

type ActivityStats = {
  actions: number;
  taskEvents: number;
  authEvents: number;
  infraEvents: number;
};

const TYPE_OPTIONS = [
  { value: "", label: "All types" },
  { value: "action", label: "User actions" },
  { value: "task_event", label: "Task events" },
  { value: "auth_event", label: "Auth events" },
  { value: "infra_event", label: "Infra events" },
];

const RESOURCE_OPTIONS = [
  { value: "", label: "All resources" },
  { value: "task", label: "Tasks" },
  { value: "repo", label: "Repos" },
  { value: "workflow", label: "Workflows" },
  { value: "connection", label: "Connections" },
  { value: "secret", label: "Secrets" },
  { value: "webhook", label: "Webhooks" },
  { value: "session", label: "Sessions" },
];

const DAYS_OPTIONS = [
  { value: 1, label: "Today" },
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
];

const TYPE_COLORS: Record<string, string> = {
  action: "text-primary",
  task_event: "text-blue-400",
  auth_event: "text-warning",
  infra_event: "text-error",
};

const TYPE_BG: Record<string, string> = {
  action: "bg-primary/10",
  task_event: "bg-blue-400/10",
  auth_event: "bg-warning/10",
  infra_event: "bg-error/10",
};

function getResourceIcon(resourceType: string) {
  switch (resourceType) {
    case "task":
      return ListTodo;
    case "repo":
      return FolderGit2;
    case "workflow":
    case "workflow_run":
    case "workflow_trigger":
      return GitBranch;
    case "connection":
    case "connection_provider":
    case "connection_assignment":
      return Plug;
    case "secret":
      return KeyRound;
    case "webhook":
      return Webhook;
    case "session":
      return Terminal;
    case "settings":
    case "mcp_server":
      return Settings;
    case "auth":
      return Shield;
    case "pod":
      return Server;
    case "review":
      return Zap;
    default:
      return Activity;
  }
}

function formatAction(action: string): string {
  return action.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getResourceIcon(item.resourceType);
  const typeColor = TYPE_COLORS[item.type] ?? "text-text-muted";
  const typeBg = TYPE_BG[item.type] ?? "bg-bg-hover";

  const resourceLink =
    item.resourceType === "task" && item.resourceId
      ? `/tasks/${item.resourceId}`
      : item.resourceType === "workflow" && item.resourceId
        ? `/jobs/${item.resourceId}`
        : item.resourceType === "session" && item.resourceId
          ? `/sessions/${item.resourceId}`
          : null;

  return (
    <div className="flex gap-3 px-4 py-2.5 hover:bg-bg-hover/40 transition-colors">
      <span
        className={cn(
          "w-7 h-7 rounded-md flex items-center justify-center shrink-0 mt-0.5",
          typeBg,
        )}
      >
        <Icon className={cn("w-3.5 h-3.5", typeColor)} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm min-w-0">
          {item.actor && (
            <span className="font-medium text-text mr-1.5">{item.actor.displayName}</span>
          )}
          <span className="text-text-muted">{item.summary}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-text-muted flex-wrap">
          <span>{formatRelativeTime(item.timestamp)}</span>
          <span
            className={cn(
              "px-1.5 py-px rounded text-[10px] font-medium uppercase tracking-wider",
              typeBg,
              typeColor,
            )}
          >
            {item.type.replace("_", " ")}
          </span>
          {resourceLink && (
            <Link href={resourceLink} className="text-primary hover:underline">
              View {item.resourceType}
            </Link>
          )}
          {item.details && Object.keys(item.details).length > 0 && (
            <button
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              className="flex items-center gap-0.5 hover:text-text transition-colors"
            >
              {expanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              Details
            </button>
          )}
        </div>
        {expanded && item.details && (
          <pre className="mt-2 p-2 rounded-lg bg-bg border border-border/60 text-xs text-text-muted overflow-x-auto">
            {JSON.stringify(item.details, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

export default function ActivityPage() {
  usePageTitle("Activity");

  const [items, setItems] = useState<ActivityItem[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<ActivityStats>({
    actions: 0,
    taskEvents: 0,
    authEvents: 0,
    infraEvents: 0,
  });
  const [loading, setLoading] = useState(true);

  const [typeFilter, setTypeFilter] = useState("");
  const [resourceFilter, setResourceFilter] = useState("");
  const [daysFilter, setDaysFilter] = useState(7);
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const fetchActivity = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getActivityFeed({
        days: daysFilter,
        type: typeFilter || undefined,
        resourceType: resourceFilter || undefined,
        limit,
        offset,
      });
      setItems(data.items);
      setTotal(data.total);
      setStats(data.stats);
    } catch {
      // handled silently
    } finally {
      setLoading(false);
    }
  }, [daysFilter, typeFilter, resourceFilter, offset]);

  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

  // Listen for real-time activity events
  useEffect(() => {
    const handler = () => {
      if (offset === 0) fetchActivity();
    };
    window.addEventListener("optio:activity-new", handler);
    return () => window.removeEventListener("optio:activity-new", handler);
  }, [fetchActivity, offset]);

  // Group items by day
  const groupedByDay = items.reduce<Record<string, ActivityItem[]>>((acc, item) => {
    const day = new Date(item.timestamp).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    if (!acc[day]) acc[day] = [];
    acc[day].push(item);
    return acc;
  }, {});

  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  const filtered = !!typeFilter || !!resourceFilter;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        icon={Activity}
        title="Activity"
        description="Who did what across the workspace: user actions plus task, auth, and infra events."
        meta={
          <span>
            {total} event{total !== 1 ? "s" : ""}{" "}
            {daysFilter === 1 ? "today" : `in the last ${daysFilter} days`}
          </span>
        }
        actions={
          <button
            onClick={fetchActivity}
            className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          </button>
        }
      />

      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile label="User actions" icon={User} value={stats.actions} />
          <StatTile label="Task events" icon={ListTodo} value={stats.taskEvents} />
          <StatTile label="Auth events" icon={Shield} value={stats.authEvents} />
          <StatTile
            label="Infra events"
            icon={Server}
            value={stats.infraEvents}
            tone={stats.infraEvents > 0 ? "text-error" : undefined}
          />
        </div>

        {/* Filters */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              aria-label="Event type"
              surface="card"
              wrap
              value={typeFilter}
              onChange={(v) => {
                setTypeFilter(v);
                setOffset(0);
              }}
              options={TYPE_OPTIONS}
            />
            <Segmented
              aria-label="Period"
              surface="card"
              value={String(daysFilter)}
              onChange={(v) => {
                setDaysFilter(Number(v));
                setOffset(0);
              }}
              options={DAYS_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            />
          </div>
          <Segmented
            aria-label="Resource"
            surface="card"
            wrap
            value={resourceFilter}
            onChange={(v) => {
              setResourceFilter(v);
              setOffset(0);
            }}
            options={RESOURCE_OPTIONS}
          />
        </div>

        {/* Timeline */}
        {loading && items.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-14 skeleton-shimmer rounded-lg" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Activity}
            title="No activity"
            description={
              filtered
                ? "Nothing matches the selected filters in this period."
                : "Nothing has happened in this period yet."
            }
          />
        ) : (
          <div className="space-y-4">
            {Object.entries(groupedByDay).map(([day, dayItems]) => (
              <Panel
                key={day}
                title={day}
                actions={<span className="text-text-muted tabular-nums">{dayItems.length}</span>}
              >
                <div className="divide-y divide-border/40">
                  {dayItems.map((item) => (
                    <ActivityRow key={item.id} item={item} />
                  ))}
                </div>
              </Panel>
            ))}
          </div>
        )}

        {/* Pagination */}
        {(hasPrev || hasNext) && (
          <div className="flex items-center justify-between">
            <button
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={!hasPrev}
              className="px-3 py-1.5 rounded-lg bg-bg-card border border-border text-xs font-medium text-text-muted hover:text-text hover:bg-bg-hover disabled:opacity-40 transition-colors"
            >
              Previous
            </button>
            <span className="text-xs text-text-muted tabular-nums">
              {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
            <button
              onClick={() => setOffset(offset + limit)}
              disabled={!hasNext}
              className="px-3 py-1.5 rounded-lg bg-bg-card border border-border text-xs font-medium text-text-muted hover:text-text hover:bg-bg-hover disabled:opacity-40 transition-colors"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
