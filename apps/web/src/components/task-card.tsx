"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StateBadge } from "./state-badge";
import { classifyError } from "@optio/shared";
import { api } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/utils";
import {
  ExternalLink,
  RotateCcw,
  Bot,
  Link2,
  Clock,
  Moon,
  Play,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useOptioChatStore } from "@/hooks/use-optio-chat";

/** Map raw trigger/message strings to human-readable attention reasons. */
function formatAttentionReason(reason: string): string {
  if (reason.includes("auto_resume_limit")) return "Auto-resume limit reached";
  if (reason.includes("ci_failing") || reason.includes("CI checks")) return "CI checks failing";
  if (reason.includes("merge_conflicts") || reason.includes("conflicts")) return "Merge conflicts";
  if (reason.includes("changes_requested") || reason.includes("review")) return "Changes requested";
  if (reason.includes("completed_without_pr") || reason.includes("did not open a pull request"))
    return "Completed without PR";
  return reason.length > 60 ? reason.slice(0, 60) + "..." : reason;
}

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
  pendingReason?: string | null;
  lastActivityAt?: string;
  activitySubstate?: string;
  isStalled?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TaskCardProps {
  task: TaskSummary;
  subtasks?: TaskSummary[];
}

export const TaskCard = React.memo(function TaskCard({ task, subtasks }: TaskCardProps) {
  const router = useRouter();
  const optioChat = useOptioChatStore();
  const repoName = task.repoUrl.replace(/.*\/\/[^/]+\//, "").replace(/\.git$/, "");
  const [owner, repo] = repoName.includes("/") ? repoName.split("/") : ["", repoName];
  const prNumber = task.prUrl?.match(/\/pull\/(\d+)/)?.[1];

  return (
    <div
      onClick={() => router.push(`/tasks/${task.id}`)}
      className={cn(
        "block rounded-md border border-border bg-bg-card cursor-pointer overflow-hidden card-hover",
      )}
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
                  Automatic Review
                </span>
              )}
              {task.taskType === "pr_review" && (
                <span className="shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary">
                  <Bot className="w-3 h-3" />
                  Review Assistant
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
              <span className="text-[10px] text-text-muted tabular-nums cost-pill px-2 py-0.5 rounded-full font-medium">
                ${parseFloat(task.costUsd).toFixed(2)}
              </span>
            )}
            <StateBadge state={task.state} isStalled={task.isStalled} />
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

        {/* Off-peak hold indicator */}
        {task.pendingReason === "waiting_for_off_peak" && task.state === "queued" && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-info/5 border border-info/10 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Moon className="w-3 h-3 text-info/60 shrink-0" />
              <span className="text-xs text-info/70">Waiting for off-peak hours</span>
            </div>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                const btn = e.currentTarget;
                btn.textContent = "Starting...";
                btn.setAttribute("disabled", "true");
                try {
                  await api.runNowTask(task.id);
                  window.location.href = window.location.href;
                } catch {
                  btn.textContent = "Failed";
                  setTimeout(() => {
                    btn.textContent = "Run Now";
                    btn.removeAttribute("disabled");
                  }, 2000);
                }
              }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs bg-primary/10 text-primary hover:bg-primary/20 transition-all shrink-0 btn-press"
            >
              <Play className="w-3 h-3" />
              Run Now
            </button>
          </div>
        )}

        {/* Stall indicator */}
        {task.state === "running" && task.isStalled && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-warning/5 border border-warning/10 flex items-center gap-2">
            <AlertTriangle className="w-3 h-3 text-warning/60 shrink-0" />
            <span className="text-xs text-warning/70">
              No activity for{" "}
              {task.lastActivityAt ? formatRelativeTime(task.lastActivityAt) : "a while"}
            </span>
          </div>
        )}

        {/* Error / attention reason section */}
        {task.state === "failed" && task.errorMessage && (
          <div className="mt-3 px-3 py-2.5 rounded-lg bg-error/5 border border-error/10 flex items-center justify-between gap-2">
            <span className="text-xs text-error/80 truncate">
              {classifyError(task.errorMessage).title}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  optioChat.setPrefillInput(
                    `Task #${task.id.slice(0, 8)} failed with: ${classifyError(task.errorMessage!).title}`,
                  );
                  optioChat.open();
                }}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-primary/5 text-primary/70 hover:bg-primary/10 hover:text-primary transition-all btn-press"
                title="Ask Optio about this error"
              >
                <Bot className="w-3 h-3" />
              </button>
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
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs bg-primary/10 text-primary hover:bg-primary/20 transition-all btn-press"
              >
                <RotateCcw className="w-3 h-3" />
                Retry
              </button>
            </div>
          </div>
        )}
        {task.state === "needs_attention" && task.errorMessage && (
          <div className="mt-3 px-3 py-2.5 rounded-lg bg-warning/5 border border-warning/10 flex items-center justify-between gap-2">
            <span className="text-xs text-warning/80 truncate">
              {formatAttentionReason(task.errorMessage)}
            </span>
            <button
              onClick={async (e) => {
                e.stopPropagation();
                const btn = e.currentTarget;
                btn.textContent = "Restarting...";
                btn.setAttribute("disabled", "true");
                try {
                  await api.forceRestartTask(task.id);
                  window.location.href = window.location.href;
                } catch {
                  btn.textContent = "Failed";
                  setTimeout(() => {
                    btn.textContent = "Restart";
                    btn.removeAttribute("disabled");
                  }, 2000);
                }
              }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs bg-primary/10 text-primary hover:bg-primary/20 transition-all shrink-0 btn-press"
            >
              <RotateCcw className="w-3 h-3" />
              Restart
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
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
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
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
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
