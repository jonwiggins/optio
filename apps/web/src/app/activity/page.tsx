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
  AlertTriangle,
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
  Loader2,
} from "lucide-react";

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
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
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

function ActivityCard({ item }: { item: ActivityItem }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = getResourceIcon(item.resourceType);
  const typeColor = TYPE_COLORS[item.type] ?? "text-text-muted";
  const typeBg = TYPE_BG[item.type] ?? "bg-bg-hover";

  const resourceLink =
    item.resourceType === "task" && item.resourceId
      ? `/tasks/${item.resourceId}`
      : item.resourceType === "workflow" && item.resourceId
        ? `/workflows/${item.resourceId}`
        : item.resourceType === "session" && item.resourceId
          ? `/sessions/${item.resourceId}`
          : null;

  return (
    <div className="flex gap-3 py-3 px-4 rounded-lg hover:bg-bg-hover/40 transition-colors group">
      <div
        className={cn(
          "w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
          typeBg,
        )}
      >
        <Icon className={cn("w-4 h-4", typeColor)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          {item.actor && <span className="font-medium text-text">{item.actor.displayName}</span>}
          <span className="text-text-muted">{item.summary}</span>
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs text-text-muted">
          <span>{formatRelativeTime(item.timestamp)}</span>
          <span className="opacity-40">·</span>
          <span
            className={cn(
              "px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider",
              typeBg,
              typeColor,
            )}
          >
            {item.type.replace("_", " ")}
          </span>
          {resourceLink && (
            <>
              <span className="opacity-40">·</span>
              <Link href={resourceLink} className="text-primary hover:underline">
                View {item.resourceType}
              </Link>
            </>
          )}
        </div>
        {item.details && Object.keys(item.details).length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 mt-1.5 text-xs text-text-muted hover:text-text transition-colors"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Details
          </button>
        )}
        {expanded && item.details && (
          <pre className="mt-2 p-2 rounded bg-bg-hover/60 text-xs text-text-muted overflow-x-auto">
            {JSON.stringify(item.details, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function StatsBar({ stats }: { stats: ActivityStats }) {
  const total = stats.actions + stats.taskEvents + stats.authEvents + stats.infraEvents;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
        <div className="text-xs text-text-muted mb-1">User Actions</div>
        <div className="text-lg font-semibold text-text">{stats.actions}</div>
      </div>
      <div className="p-3 rounded-lg bg-blue-400/5 border border-blue-400/10">
        <div className="text-xs text-text-muted mb-1">Task Events</div>
        <div className="text-lg font-semibold text-text">{stats.taskEvents}</div>
      </div>
      <div className="p-3 rounded-lg bg-warning/5 border border-warning/10">
        <div className="text-xs text-text-muted mb-1">Auth Events</div>
        <div className="text-lg font-semibold text-text">{stats.authEvents}</div>
      </div>
      <div className="p-3 rounded-lg bg-error/5 border border-error/10">
        <div className="text-xs text-text-muted mb-1">Infra Events</div>
        <div className="text-lg font-semibold text-text">{stats.infraEvents}</div>
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

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6 stagger">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gradient">Activity</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {total} event{total !== 1 ? "s" : ""} in the last {daysFilter} day
            {daysFilter !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={fetchActivity}
          className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
        >
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
        </button>
      </div>

      <StatsBar stats={stats} />

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setOffset(0);
          }}
          className="px-3 py-1.5 rounded-lg bg-bg-hover border border-border text-sm text-text"
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={resourceFilter}
          onChange={(e) => {
            setResourceFilter(e.target.value);
            setOffset(0);
          }}
          className="px-3 py-1.5 rounded-lg bg-bg-hover border border-border text-sm text-text"
        >
          {RESOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={daysFilter}
          onChange={(e) => {
            setDaysFilter(Number(e.target.value));
            setOffset(0);
          }}
          className="px-3 py-1.5 rounded-lg bg-bg-hover border border-border text-sm text-text"
        >
          {DAYS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Timeline */}
      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16">
          <Activity className="w-10 h-10 text-text-muted/40 mx-auto mb-3" />
          <p className="text-text-muted">No activity found for the selected filters</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedByDay).map(([day, dayItems]) => (
            <div key={day}>
              <div className="flex items-center gap-2 mb-2">
                <div className="h-px flex-1 bg-border/50" />
                <span className="text-xs font-medium text-text-muted px-2">{day}</span>
                <div className="h-px flex-1 bg-border/50" />
              </div>
              <div className="space-y-0.5">
                {dayItems.map((item) => (
                  <ActivityCard key={item.id} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {(hasPrev || hasNext) && (
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={!hasPrev}
            className="px-3 py-1.5 rounded-lg bg-bg-hover border border-border text-sm text-text disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs text-text-muted">
            {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={!hasNext}
            className="px-3 py-1.5 rounded-lg bg-bg-hover border border-border text-sm text-text disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
