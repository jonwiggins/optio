import Link from "next/link";
import { cn } from "@/lib/utils";
import { Activity, CheckCircle, AlertTriangle, GitMerge, Eye, ListChecks } from "lucide-react";
import type { TaskStats } from "./types.js";

function PipelineStat({
  icon: Icon,
  label,
  value,
  color,
  active,
  stage,
}: {
  icon: any;
  label: string;
  value: number;
  color: string;
  active?: boolean;
  stage: string;
}) {
  return (
    <Link
      href={`/tasks?stage=${stage}&timeFilter=`}
      className={cn(
        "flex flex-col items-center gap-1.5 px-4 py-2 rounded-lg transition-colors hover:bg-bg-hover",
        active && "bg-bg-hover/60",
      )}
    >
      <span
        className={cn("text-4xl font-bold tabular-nums", value > 0 ? color : "text-text-muted/30")}
      >
        {value}
      </span>
      <div className="flex items-center gap-1.5">
        <Icon className={cn("w-3.5 h-3.5 shrink-0", value > 0 ? color : "text-text-muted/25")} />
        <span className="text-xs text-text-muted/60 font-medium uppercase tracking-wider">
          {label}
        </span>
      </div>
    </Link>
  );
}

function PipelineArrow() {
  return <span className="text-text-muted/20 text-lg self-center px-1">&rsaquo;</span>;
}

export function PipelineStatsBar({ taskStats }: { taskStats: TaskStats | null }) {
  return (
    <div className="rounded-md border border-border bg-bg-card px-6 py-5 flex flex-wrap justify-around items-center gap-y-4">
      <PipelineStat
        icon={ListChecks}
        label="Queue"
        value={taskStats?.queued ?? 0}
        color="text-text-muted"
        stage="queue"
      />
      <PipelineArrow />
      <PipelineStat
        icon={Activity}
        label="Running"
        value={taskStats?.running ?? 0}
        color="text-primary"
        active={!!taskStats?.running}
        stage="running"
      />
      <PipelineArrow />
      <PipelineStat
        icon={GitMerge}
        label="CI"
        value={taskStats?.ci ?? 0}
        color="text-info"
        stage="ci"
      />
      <PipelineArrow />
      <PipelineStat
        icon={Eye}
        label="Review"
        value={taskStats?.review ?? 0}
        color="text-info"
        stage="review"
      />
      <PipelineArrow />
      <PipelineStat
        icon={AlertTriangle}
        label="Attention"
        value={taskStats?.needsAttention ?? 0}
        color="text-warning"
        active={!!taskStats?.needsAttention}
        stage="attention"
      />
      <PipelineArrow />
      <PipelineStat
        icon={AlertTriangle}
        label="Failed"
        value={taskStats?.failed ?? 0}
        color="text-error"
        active={!!taskStats?.failed}
        stage="failed"
      />
      <PipelineArrow />
      <PipelineStat
        icon={CheckCircle}
        label="Done"
        value={taskStats?.completed ?? 0}
        color="text-success"
        stage="done"
      />
    </div>
  );
}
