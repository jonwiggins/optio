"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StateBadge } from "./state-badge";
import { classifyError } from "@optio/shared";
import { api } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/utils";
import { ExternalLink, RotateCcw, Bot, Link2, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface TaskSummary {
  id: string;
  title: string;
  state: string;
  agentType: string;
  repoUrl: string;
  prUrl?: string;
  costUsd?: string;
  errorMessage?: string;
  taskType?: string;
  parentTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskCardProps {
  task: TaskSummary;
  subtasks?: TaskSummary[];
}

export const TaskCard = React.memo(function TaskCard({ task, subtasks }: TaskCardProps) {
  const router = useRouter();
  const repoName = task.repoUrl.replace(/.*\/\/[^/]+\//, "").replace(/\.git$/, "");
  const [owner, repo] = repoName.includes("/") ? repoName.split("/") : ["", repoName];
  const prNumber = task.prUrl?.match(/\/pull\/(\d+)/)?.[1];

  return (
    <div
      onClick={() => router.push(`/tasks/${task.id}`)}
      className="block rounded-xl border border-border/50 bg-bg-card hover:border-border-strong hover:bg-bg-card-hover hover:shadow-md transition-all duration-150 cursor-pointer overflow-hidden"
    >
      <div className="p-5">
        {/* Top row: title + badges */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-sm tracking-tight truncate">{task.title}</h3>
              {task.taskType === "review" && (
                <span className="shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-info/10 text-info">
                  <Bot className="w-3 h-3" />
                  Review
                </span>
              )}
            </div>
            {/* Metadata row */}
            <div className="flex items-center gap-1.5 mt-2 text-xs text-text-muted">
              <span className="text-text-muted/50">{owner}/</span>
              <span>{repo}</span>
              <span className="text-text-muted/30 mx-1">&middot;</span>
              <span className="capitalize">{task.agentType.replace("-", " ")}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {task.costUsd && (
              <span className="text-[11px] text-text-muted/40 tabular-nums">
                ${parseFloat(task.costUsd).toFixed(2)}
              </span>
            )}
            <StateBadge state={task.state} />
          </div>
        </div>

        {/* Blocked / waiting on deps indicator */}
        {task.state === "waiting_on_deps" && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-warning/5 border border-warning/10 flex items-center gap-2">
            <Link2 className="w-3 h-3 text-warning/60 shrink-0" />
            <span className="text-xs text-warning/70">Waiting for dependencies to complete</span>
          </div>
        )}

        {/* Pipeline step pending indicator */}
        {task.state === "pending" && task.taskType === "step" && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-bg-hover/50 border border-border/50 flex items-center gap-2">
            <Clock className="w-3 h-3 text-text-muted/50 shrink-0" />
            <span className="text-xs text-text-muted/60">Waiting for previous step</span>
          </div>
        )}

        {/* Error section */}
        {task.state === "failed" && task.errorMessage && (
          <div className="mt-3 px-3 py-2.5 rounded-lg bg-error/5 border border-error/10 flex items-center justify-between gap-2">
            <span className="text-xs text-error/80 truncate">
              {classifyError(task.errorMessage).title}
            </span>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                const btn = e.currentTarget;
                btn.textContent = "Retrying...";
                btn.setAttribute("disabled", "true");
                try {
                  await api.retryTask(task.id);
                  window.location.href = window.location.href;
                } catch {
                  btn.textContent = "Failed";
                  setTimeout(() => {
                    btn.textContent = "Retry";
                    btn.removeAttribute("disabled");
                  }, 2000);
                }
              }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs bg-primary/10 text-primary hover:bg-primary/20 transition-colors shrink-0"
            >
              <RotateCcw className="w-3 h-3" />
              Retry
            </button>
          </div>
        )}

        {/* Footer: time + PR */}
        <div className="flex items-center justify-between mt-4 text-xs text-text-muted/60">
          <span>{formatRelativeTime(task.createdAt)}</span>
          {prNumber && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 text-text-muted hover:text-text transition-colors"
            >
              PR #{prNumber}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>

      {/* Subtasks — rendered inside the card */}
      {subtasks && subtasks.length > 0 && (
        <div className="border-t border-border/30 bg-bg-subtle/50 px-5 py-3 space-y-1.5">
          {subtasks.map((sub) => (
            <Link
              key={sub.id}
              href={`/tasks/${sub.id}`}
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors hover:bg-bg-hover",
                sub.taskType === "review" ? "bg-info/5" : "bg-bg-card/50",
              )}
            >
              {sub.taskType === "review" ? (
                <Bot className="w-3.5 h-3.5 text-info shrink-0" />
              ) : (
                <span className="w-3.5 h-3.5 text-text-muted shrink-0 text-center">&bull;</span>
              )}
              <span className="truncate flex-1 text-text-muted">{sub.title}</span>
              <StateBadge state={sub.state} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
});
