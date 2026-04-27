import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  Activity,
  CheckCircle,
  AlertTriangle,
  GitMerge,
  Eye,
  ListChecks,
  Pause,
  Moon,
  Archive,
  XCircle,
} from "lucide-react";
import type { TaskStats, StandaloneStats, PersistentAgentStats, SessionStats } from "./types.js";

type Stage = {
  key: string;
  label: string;
  value: number;
  icon: typeof Activity;
  color: string;
  href: string;
};

function taskStages(stats: TaskStats | null): Stage[] {
  return [
    {
      key: "queue",
      label: "Queue",
      value: stats?.queued ?? 0,
      icon: ListChecks,
      color: "var(--color-text-muted)",
      href: "/tasks?stage=queue&timeFilter=",
    },
    {
      key: "running",
      label: "Running",
      value: stats?.running ?? 0,
      icon: Activity,
      color: "var(--color-primary)",
      href: "/tasks?stage=running&timeFilter=",
    },
    {
      key: "ci",
      label: "CI",
      value: stats?.ci ?? 0,
      icon: GitMerge,
      color: "var(--color-info)",
      href: "/tasks?stage=ci&timeFilter=",
    },
    {
      key: "review",
      label: "Review",
      value: stats?.review ?? 0,
      icon: Eye,
      color: "var(--color-info)",
      href: "/tasks?stage=review&timeFilter=",
    },
    {
      key: "attention",
      label: "Attention",
      value: stats?.needsAttention ?? 0,
      icon: AlertTriangle,
      color: "var(--color-warning)",
      href: "/tasks?stage=attention&timeFilter=",
    },
    {
      key: "failed",
      label: "Failed",
      value: stats?.failed ?? 0,
      icon: AlertTriangle,
      color: "var(--color-error)",
      href: "/tasks?stage=failed&timeFilter=",
    },
    {
      key: "done",
      label: "Done",
      value: stats?.completed ?? 0,
      icon: CheckCircle,
      color: "var(--color-success)",
      href: "/tasks?stage=done&timeFilter=",
    },
  ];
}

function standaloneStages(stats: StandaloneStats | null): Stage[] {
  const href = "/tasks?tab=standalone";
  return [
    {
      key: "queue",
      label: "Queue",
      value: stats?.queued ?? 0,
      icon: ListChecks,
      color: "var(--color-text-muted)",
      href,
    },
    {
      key: "running",
      label: "Running",
      value: stats?.running ?? 0,
      icon: Activity,
      color: "var(--color-primary)",
      href,
    },
    {
      key: "failed",
      label: "Failed",
      value: stats?.failed ?? 0,
      icon: AlertTriangle,
      color: "var(--color-error)",
      href,
    },
    {
      key: "done",
      label: "Done",
      value: stats?.completed ?? 0,
      icon: CheckCircle,
      color: "var(--color-success)",
      href,
    },
  ];
}

function agentStages(stats: PersistentAgentStats | null): Stage[] {
  const href = "/agents";
  return [
    {
      key: "idle",
      label: "Idle",
      value: stats?.idle ?? 0,
      icon: Moon,
      color: "var(--color-text-muted)",
      href,
    },
    {
      key: "queue",
      label: "Queue",
      value: stats?.queued ?? 0,
      icon: ListChecks,
      color: "var(--color-text-muted)",
      href,
    },
    {
      key: "running",
      label: "Running",
      value: stats?.running ?? 0,
      icon: Activity,
      color: "var(--color-primary)",
      href,
    },
    {
      key: "paused",
      label: "Paused",
      value: stats?.paused ?? 0,
      icon: Pause,
      color: "var(--color-warning)",
      href,
    },
    {
      key: "failed",
      label: "Failed",
      value: stats?.failed ?? 0,
      icon: AlertTriangle,
      color: "var(--color-error)",
      href,
    },
    {
      key: "archived",
      label: "Archived",
      value: stats?.archived ?? 0,
      icon: Archive,
      color: "var(--color-text-muted)",
      href,
    },
  ];
}

function sessionStages(stats: SessionStats | null): Stage[] {
  const href = "/sessions";
  return [
    {
      key: "active",
      label: "Active",
      value: stats?.active ?? 0,
      icon: Activity,
      color: "var(--color-primary)",
      href,
    },
    {
      key: "ended",
      label: "Ended (24h)",
      value: stats?.ended ?? 0,
      icon: XCircle,
      color: "var(--color-text-muted)",
      href,
    },
  ];
}

type PipelineStatsBarProps =
  | { variant?: "tasks"; taskStats: TaskStats | null }
  | { variant: "standalone"; standaloneStats: StandaloneStats | null }
  | { variant: "agents"; agentStats: PersistentAgentStats | null }
  | { variant: "sessions"; sessionStats: SessionStats | null };

export function PipelineStatsBar(props: PipelineStatsBarProps) {
  let stages: Stage[];
  switch (props.variant) {
    case "standalone":
      stages = standaloneStages(props.standaloneStats);
      break;
    case "agents":
      stages = agentStages(props.agentStats);
      break;
    case "sessions":
      stages = sessionStages(props.sessionStats);
      break;
    default:
      stages = taskStages(props.taskStats);
  }

  return (
    <div className="rounded-xl border border-border/50 bg-bg-card overflow-hidden">
      <div className="flex divide-x divide-border/30">
        {stages.map((stage) => {
          const active = stage.value > 0;
          const Icon = stage.icon;

          return (
            <Link
              key={stage.key}
              href={stage.href}
              className="flex-1 relative py-5 flex flex-col items-center gap-1.5 hover:bg-bg-hover/30 transition-all group"
            >
              {/* Colored top accent bar for active stages */}
              {active && (
                <div
                  className="absolute top-0 inset-x-0 h-0.5"
                  style={{ backgroundColor: stage.color }}
                />
              )}

              <span
                className={cn(
                  "text-3xl font-bold tabular-nums tracking-tight font-mono transition-colors",
                  !active && "text-text-muted/15",
                )}
                style={active ? { color: stage.color } : undefined}
              >
                {stage.value}
              </span>

              <div className="flex items-center gap-1.5">
                <Icon
                  className={cn("w-3 h-3 transition-colors", !active && "text-text-muted/20")}
                  style={active ? { color: stage.color } : undefined}
                />
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted/50">
                  {stage.label}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
