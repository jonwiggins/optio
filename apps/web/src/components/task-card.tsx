import Link from "next/link";
import { StateBadge } from "./state-badge";
import { classifyError } from "@optio/shared";
import { api } from "@/lib/api-client";
import { formatRelativeTime, truncate } from "@/lib/utils";
import { GitBranch, ExternalLink, RotateCcw, Bot } from "lucide-react";

interface TaskCardProps {
  task: {
    id: string;
    title: string;
    state: string;
    agentType: string;
    repoUrl: string;
    prUrl?: string;
    costUsd?: string;
    errorMessage?: string;
    taskType?: string;
    createdAt: string;
    updatedAt: string;
  };
}

export function TaskCard({ task }: TaskCardProps) {
  const repoName = task.repoUrl.replace(/.*\/\/[^/]+\//, "").replace(/\.git$/, "");

  return (
    <Link
      href={`/tasks/${task.id}`}
      className="block p-4 rounded-lg border border-border bg-bg-card hover:bg-bg-hover transition-colors overflow-hidden"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm truncate">{task.title}</h3>
            {task.taskType === "review" && (
              <span className="shrink-0 flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-info/10 text-info border border-info/20">
                <Bot className="w-2.5 h-2.5" />
                Review
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1.5 text-xs text-text-muted">
            <GitBranch className="w-3 h-3" />
            <span>{truncate(repoName, 30)}</span>
            <span className="opacity-50">·</span>
            <span className="capitalize">{task.agentType.replace("-", " ")}</span>
          </div>
        </div>
        <StateBadge state={task.state} />
      </div>
      {task.state === "failed" && (
        <div className="flex items-center justify-between mt-2">
          {task.errorMessage && (
            <span className="text-xs text-error/70 truncate">
              {classifyError(task.errorMessage).title}
            </span>
          )}
          <button
            onClick={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              try {
                await api.retryTask(task.id);
                window.location.reload();
              } catch {}
            }}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-primary/10 text-primary hover:bg-primary/20 shrink-0 ml-2"
          >
            <RotateCcw className="w-3 h-3" />
            Retry
          </button>
        </div>
      )}
      <div className="flex items-center justify-between mt-3 text-xs text-text-muted">
        <span>{formatRelativeTime(task.createdAt)}</span>
        {task.costUsd && (
          <span className="text-text-muted">${parseFloat(task.costUsd).toFixed(4)}</span>
        )}
        {task.prUrl && (
          <span className="flex items-center gap-1 text-success">
            <ExternalLink className="w-3 h-3" />
            PR
          </span>
        )}
      </div>
    </Link>
  );
}
