import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Activity,
  ListTodo,
  FolderGit2,
  GitBranch,
  Plug,
  KeyRound,
  Webhook,
  Terminal,
  Settings,
  Shield,
  Server,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatRelativeTime } from "@/lib/utils";
import { EmptyState } from "./empty-state.js";

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

export function RecentActivity() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchActivity = useCallback(async () => {
    try {
      const data = await api.getActivityFeed({ days: 1, limit: 8 });
      setItems(data.items);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

  // Listen for real-time updates
  useEffect(() => {
    const handler = () => fetchActivity();
    window.addEventListener("optio:activity-new", handler);
    return () => window.removeEventListener("optio:activity-new", handler);
  }, [fetchActivity]);

  if (loading) {
    return (
      <div className="min-w-0 overflow-hidden">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-text-heading">Recent Activity</h2>
        </div>
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-12 skeleton-shimmer rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-text-heading">Recent Activity</h2>
        <Link href="/activity" className="text-xs text-primary hover:underline">
          All &rarr;
        </Link>
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No recent activity"
          description="Actions and events will appear here as you use Optio."
        />
      ) : (
        <div className="space-y-0.5">
          {items.map((item) => {
            const Icon = getResourceIcon(item.resourceType);
            const typeColor = TYPE_COLORS[item.type] ?? "text-text-muted";
            const typeBg = TYPE_BG[item.type] ?? "bg-bg-hover";
            return (
              <div
                key={item.id}
                className="flex items-center gap-2.5 py-2 px-2 rounded-lg hover:bg-bg-hover/40 transition-colors"
              >
                <div
                  className={cn(
                    "w-6 h-6 rounded flex items-center justify-center shrink-0",
                    typeBg,
                  )}
                >
                  <Icon className={cn("w-3 h-3", typeColor)} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-text truncate">{item.summary}</p>
                  <p className="text-[10px] text-text-muted">
                    {item.actor?.displayName ? `${item.actor.displayName} · ` : ""}
                    {formatRelativeTime(item.timestamp)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
