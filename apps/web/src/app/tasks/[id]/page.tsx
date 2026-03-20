"use client";

import { use, useState, useEffect } from "react";
import { useTask } from "@/hooks/use-task";
import { LogViewer } from "@/components/log-viewer";
import { EventTimeline } from "@/components/event-timeline";
import { StateBadge } from "@/components/state-badge";
import { api } from "@/lib/api-client";
import { classifyError } from "@optio/shared";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Loader2,
  RefreshCw,
  XCircle,
  RotateCcw,
  ExternalLink,
  GitBranch,
  Clock,
  Send,
  AlertCircle,
  Eye,
} from "lucide-react";
import { toast } from "sonner";

export default function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { task, events, loading, error, refresh } = useTask(id);
  const [actionLoading, setActionLoading] = useState(false);
  const [resumePrompt, setResumePrompt] = useState("");
  const [showEvents, setShowEvents] = useState(false);

  // Auto-refresh task state periodically when active
  useEffect(() => {
    if (!task) return;
    const isActive = ["running", "provisioning", "queued"].includes(task.state);
    if (!isActive) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [task?.state, refresh]);

  const handleCancel = async () => {
    setActionLoading(true);
    try {
      await api.cancelTask(id);
      await refresh();
    } catch {}
    setActionLoading(false);
  };

  const handleRetry = async () => {
    setActionLoading(true);
    try {
      await api.retryTask(id);
      await refresh();
    } catch {}
    setActionLoading(false);
  };

  const handleResume = async () => {
    if (!resumePrompt.trim()) return;
    setActionLoading(true);
    try {
      await api.resumeTask(id, resumePrompt);
      setResumePrompt("");
      await refresh();
    } catch {}
    setActionLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading task...
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="flex items-center justify-center h-full text-error">
        {error ?? "Task not found"}
      </div>
    );
  }

  const repoName = task.repoUrl.replace(/.*\/\/[^/]+\//, "").replace(/\.git$/, "");
  const isActive = ["running", "provisioning", "queued"].includes(task.state);
  const isTerminal = ["completed", "failed", "cancelled"].includes(task.state);
  const canCancel = ["running", "queued", "provisioning", "needs_attention"].includes(task.state);
  const canRetry = ["failed", "cancelled"].includes(task.state);
  const canResume = ["needs_attention", "failed"].includes(task.state) && !!task.sessionId;

  // (log filtering is handled by LogViewer component)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 p-4 border-b border-border bg-bg-card">
        <div className="flex items-start justify-between gap-4 max-w-5xl mx-auto">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-bold truncate">{task.title}</h1>
              <StateBadge state={task.state} />
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
              <span className="flex items-center gap-1">
                <GitBranch className="w-3 h-3" />
                {repoName}
              </span>
              <span className="flex items-center gap-1 capitalize">
                {task.agentType === "claude-code" ? (
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073z" />
                  </svg>
                )}
                {task.agentType.replace("-", " ")}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatRelativeTime(task.createdAt)}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-success/10 text-success text-xs hover:bg-success/20 transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                View PR
              </a>
            )}
            {canCancel && (
              <button
                onClick={handleCancel}
                disabled={actionLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 transition-colors disabled:opacity-50"
              >
                <XCircle className="w-3 h-3" />
                Cancel
              </button>
            )}
            {canRetry && (
              <button
                onClick={handleRetry}
                disabled={actionLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 transition-colors disabled:opacity-50"
              >
                <RotateCcw className="w-3 h-3" />
                Retry
              </button>
            )}
            <button
              onClick={refresh}
              className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Error panel */}
      {task.errorMessage &&
        isTerminal &&
        (() => {
          const classified = classifyError(task.errorMessage);
          return (
            <div className="shrink-0 border-b border-error/20 bg-error/5">
              <div className="max-w-5xl mx-auto px-4 py-3">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-error shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div>
                      <h3 className="text-sm font-medium text-error">{classified.title}</h3>
                      <p className="text-xs text-error/70 mt-0.5">{classified.description}</p>
                    </div>
                    <div className="p-2.5 rounded-md bg-bg/50 border border-border">
                      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                        Suggested fix
                      </div>
                      <pre className="text-xs text-text/80 whitespace-pre-wrap font-mono">
                        {classified.remedy}
                      </pre>
                    </div>
                    <div className="flex items-center gap-2">
                      {classified.retryable && canRetry && (
                        <button
                          onClick={handleRetry}
                          disabled={actionLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Retry Task
                        </button>
                      )}
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-error/10 text-error">
                        {classified.category}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

      {/* PR Status */}
      {task.prUrl && (
        <div className="shrink-0 border-b border-border bg-bg-card px-4 py-3">
          <div className="max-w-5xl mx-auto">
            <div className="flex items-center gap-4 text-xs">
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-primary hover:underline font-medium"
              >
                <ExternalLink className="w-3 h-3" />
                PR #{task.prNumber ?? "?"}
              </a>

              {/* CI Checks */}
              {task.prChecksStatus && task.prChecksStatus !== "none" && (
                <span
                  className={cn(
                    "flex items-center gap-1",
                    task.prChecksStatus === "passing"
                      ? "text-success"
                      : task.prChecksStatus === "failing"
                        ? "text-error"
                        : "text-warning",
                  )}
                >
                  <span
                    className={cn(
                      "w-2 h-2 rounded-full",
                      task.prChecksStatus === "passing"
                        ? "bg-success"
                        : task.prChecksStatus === "failing"
                          ? "bg-error"
                          : "bg-warning",
                    )}
                  />
                  CI: {task.prChecksStatus}
                </span>
              )}

              {/* Review Status */}
              {task.prReviewStatus && task.prReviewStatus !== "none" && (
                <span
                  className={cn(
                    "flex items-center gap-1",
                    task.prReviewStatus === "approved"
                      ? "text-success"
                      : task.prReviewStatus === "changes_requested"
                        ? "text-warning"
                        : "text-text-muted",
                  )}
                >
                  Review:{" "}
                  {task.prReviewStatus === "changes_requested"
                    ? "changes requested"
                    : task.prReviewStatus}
                </span>
              )}

              {/* PR State */}
              {task.prState && task.prState !== "open" && (
                <span className={task.prState === "merged" ? "text-success" : "text-text-muted"}>
                  {task.prState}
                </span>
              )}

              {/* Cost */}
              {task.costUsd && (
                <span className="text-text-muted ml-auto">
                  Cost: ${parseFloat(task.costUsd).toFixed(4)}
                </span>
              )}

              {/* Request Review */}
              {task.state === "pr_opened" && (
                <button
                  onClick={async () => {
                    setActionLoading(true);
                    try {
                      const res = await api.launchReview(id);
                      toast.success("Review agent launched");
                      refresh();
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Failed to launch review");
                    }
                    setActionLoading(false);
                  }}
                  disabled={actionLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 disabled:opacity-50 ml-auto"
                >
                  <Eye className="w-3 h-3" />
                  Request Review
                </button>
              )}
            </div>

            {/* Review comments if changes requested */}
            {task.prReviewStatus === "changes_requested" && task.prReviewComments && (
              <div className="mt-2 p-2 rounded-md bg-warning/5 border border-warning/20 text-xs">
                <div className="font-medium text-warning mb-1">Review feedback:</div>
                <pre className="text-text-muted whitespace-pre-wrap">{task.prReviewComments}</pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main content: logs + sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Log panel */}
        <div className="flex-1 flex flex-col">
          {/* Log viewer + events toggle */}
          <div className="shrink-0 flex items-center justify-end px-4 py-1 border-b border-border bg-bg">
            <button
              onClick={() => setShowEvents(!showEvents)}
              className={cn(
                "px-2 py-0.5 rounded text-xs transition-colors",
                showEvents ? "bg-primary/10 text-primary" : "text-text-muted hover:bg-bg-hover",
              )}
            >
              Events
            </button>
          </div>

          {/* Log content via LogViewer */}
          <div className="flex-1 overflow-hidden">
            <LogViewer taskId={id} />
          </div>

          {/* Resume / interact bar */}
          <div className="shrink-0 border-t border-border bg-bg-card px-4 py-2.5">
            <div className="flex gap-2 items-center">
              <input
                value={resumePrompt}
                onChange={(e) => setResumePrompt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleResume()}
                placeholder={
                  canResume
                    ? "Send follow-up instructions to the agent..."
                    : isActive
                      ? "Agent is running..."
                      : "Task has ended"
                }
                disabled={!canResume}
                className="flex-1 px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary disabled:opacity-40 disabled:cursor-not-allowed"
              />
              <button
                onClick={handleResume}
                disabled={!canResume || !resumePrompt.trim() || actionLoading}
                title={
                  !task.sessionId && isTerminal
                    ? "No session to resume — the agent didn't produce a session ID"
                    : canResume
                      ? "Resume the agent with these instructions"
                      : "Task must be in a resumable state"
                }
                className={cn(
                  "px-3 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed",
                  canResume
                    ? "bg-primary text-white hover:bg-primary-hover"
                    : "bg-bg-hover text-text-muted",
                )}
              >
                {actionLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </button>
            </div>
            {isTerminal && !task.sessionId && (
              <p className="text-[10px] text-text-muted/50 mt-1">
                Resume unavailable — no session was captured for this task.
              </p>
            )}
          </div>
        </div>

        {/* Events sidebar (togglable) */}
        {showEvents && (
          <div className="w-72 shrink-0 border-l border-border overflow-auto p-3 bg-bg-card">
            <h3 className="text-xs font-medium text-text-muted mb-3">State Timeline</h3>
            <EventTimeline events={events} />
          </div>
        )}
      </div>
    </div>
  );
}
