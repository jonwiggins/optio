"use client";

import Link from "next/link";
import { use, useState, useEffect } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { useTask } from "@/hooks/use-task";
import { LogViewer } from "@/components/log-viewer";
import { PipelineTimeline } from "@/components/pipeline-timeline";
import { ActivityFeed } from "@/components/activity-feed";
import { StateBadge } from "@/components/state-badge";
import { api } from "@/lib/api-client";
import { classifyError } from "@optio/shared";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Loader2,
  RefreshCw,
  XCircle,
  RotateCcw,
  Play,
  ExternalLink,
  GitBranch,
  Clock,
  Bot,
  Send,
  AlertCircle,
  Eye,
  Key,
  Check,
  Copy,
} from "lucide-react";
import { toast } from "sonner";

export default function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { task, events, pendingReason, pipelineProgress, loading, error, refresh } = useTask(id);
  usePageTitle(task?.title ?? "Task");
  const [actionLoading, setActionLoading] = useState(false);
  const [resumePrompt, setResumePrompt] = useState("");
  const [showTimeline, setShowTimeline] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"pipeline" | "activity">("pipeline");
  const [subtasks, setSubtasks] = useState<any[]>([]);
  const [dependencies, setDependencies] = useState<any[]>([]);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenSaving, setTokenSaving] = useState(false);
  const [dependents, setDependents] = useState<any[]>([]);
  const [showCreateSubtask, setShowCreateSubtask] = useState(false);
  const [newSubtask, setNewSubtask] = useState({
    title: "",
    prompt: "",
    taskType: "child",
    blocksParent: false,
  });

  // Auto-refresh task state periodically when active
  useEffect(() => {
    if (!task) return;
    const isActive = ["running", "provisioning", "queued"].includes(task.state);
    if (!isActive) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [task?.state, refresh]);

  useEffect(() => {
    if (task) {
      api
        .getSubtasks(id)
        .then((res) => setSubtasks(res.subtasks))
        .catch(() => {});
      api
        .getTaskDependencies(id)
        .then((res) => setDependencies(res.dependencies))
        .catch(() => {});
      api
        .getTaskDependents(id)
        .then((res) => setDependents(res.dependents))
        .catch(() => {});
    }
  }, [id, task?.state]);

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

  const handleForceRedo = async () => {
    if (
      !confirm("This will clear all logs and results and re-run the task from scratch. Continue?")
    )
      return;
    setActionLoading(true);
    try {
      await api.forceRedoTask(id);
      toast.success("Task reset and re-queued");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to force redo");
    }
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

  const handleForceRestart = async () => {
    setActionLoading(true);
    try {
      await api.forceRestartTask(id);
      toast.success("Task re-queued on existing PR branch");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restart task");
    }
    setActionLoading(false);
  };

  const handleCreateSubtask = async () => {
    if (!newSubtask.title.trim() || !newSubtask.prompt.trim()) return;
    setActionLoading(true);
    try {
      await api.createSubtask(id, {
        title: newSubtask.title,
        prompt: newSubtask.prompt,
        taskType: newSubtask.taskType as any,
        blocksParent: newSubtask.blocksParent,
      });
      toast.success("Subtask created and queued");
      setShowCreateSubtask(false);
      setNewSubtask({ title: "", prompt: "", taskType: "child", blocksParent: false });
      // Refresh subtasks
      const res = await api.getSubtasks(id);
      setSubtasks(res.subtasks);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create subtask");
    }
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
  const canForceRestart = ["needs_attention", "failed", "pr_opened"].includes(task.state);

  // (log filtering is handled by LogViewer component)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 p-4 border-b border-border bg-bg-card">
        <div className="flex items-start justify-between gap-4 max-w-5xl mx-auto">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-bold tracking-tight truncate">{task.title}</h1>
              <StateBadge state={task.state} />
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
              <span className="flex items-center gap-1">
                <GitBranch className="w-3 h-3" />
                {repoName}
              </span>
              <span className="flex items-center gap-1 capitalize">
                <Bot className="w-3 h-3" />
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
            {canForceRestart && (
              <button
                onClick={handleForceRestart}
                disabled={actionLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-success/10 text-success text-xs hover:bg-success/20 transition-colors disabled:opacity-50"
                title="Start a fresh agent session on the existing PR branch"
              >
                <Play className="w-3 h-3" />
                Attempt Resume
              </button>
            )}
            <button
              onClick={handleForceRedo}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-warning/10 text-warning text-xs hover:bg-warning/20 transition-colors disabled:opacity-50"
            >
              <RotateCcw className="w-3 h-3" />
              Force Redo
            </button>
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

      {/* Pending reason */}
      {pendingReason && (
        <div className="shrink-0 border-b border-warning/20 bg-warning/5 px-4 py-2.5">
          <div className="max-w-5xl mx-auto flex items-center gap-2 text-xs">
            <Clock className="w-3.5 h-3.5 text-warning shrink-0" />
            <span className="text-warning/80">{pendingReason}</span>
          </div>
        </div>
      )}

      {/* Pipeline progress */}
      {pipelineProgress && (
        <div className="shrink-0 border-b border-border bg-bg px-4 py-2.5">
          <div className="max-w-5xl mx-auto">
            <div className="flex items-center gap-3 text-xs">
              <span className="text-text-muted font-medium">
                Pipeline: Step {pipelineProgress.currentStepIndex} of {pipelineProgress.totalSteps}
              </span>
              {pipelineProgress.currentStepTitle && (
                <span className="text-text-muted/60 truncate">
                  — {pipelineProgress.currentStepTitle}
                </span>
              )}
              {pipelineProgress.failedSteps > 0 && (
                <span className="text-error text-[10px] px-1.5 py-0.5 rounded bg-error/10">
                  {pipelineProgress.failedSteps} failed
                </span>
              )}
            </div>
            {/* Progress bar */}
            <div className="mt-1.5 flex gap-1">
              {pipelineProgress.steps.map((step: any, i: number) => (
                <div
                  key={step.id}
                  className={cn(
                    "h-1.5 rounded-full flex-1 transition-colors",
                    step.state === "completed"
                      ? "bg-success"
                      : step.state === "failed"
                        ? "bg-error"
                        : ["running", "provisioning"].includes(step.state)
                          ? "bg-primary animate-pulse"
                          : step.state === "queued"
                            ? "bg-primary/40"
                            : "bg-border",
                  )}
                  title={`Step ${i + 1}: ${step.title} (${step.state})`}
                />
              ))}
            </div>
          </div>
        </div>
      )}

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
                    {classified.category === "auth" ? (
                      <div className="space-y-2">
                        <div className="p-2.5 rounded-md bg-bg/50 border border-border">
                          <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1.5">
                            1. Copy your token
                          </div>
                          <div className="relative group">
                            <pre className="text-[11px] text-text/80 whitespace-pre-wrap font-mono bg-bg-card rounded px-2.5 py-2 border border-border select-all break-all">
                              {`security find-generic-password -s "Claude Code-credentials" -w | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" | pbcopy`}
                            </pre>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(
                                  `security find-generic-password -s "Claude Code-credentials" -w | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" | pbcopy`,
                                );
                                toast.success("Command copied");
                              }}
                              className="absolute top-1 right-1 p-1 rounded bg-bg-hover text-text-muted hover:text-text opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <Copy className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                        <div className="p-2.5 rounded-md bg-bg/50 border border-border">
                          <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1.5">
                            2. Paste new token
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={tokenInput}
                              onChange={(e) => setTokenInput(e.target.value)}
                              placeholder="Paste token here"
                              className="flex-1 px-2.5 py-1.5 rounded-md bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary"
                            />
                            <button
                              onClick={async () => {
                                if (!tokenInput.trim()) return;
                                setTokenSaving(true);
                                try {
                                  await api.createSecret({
                                    name: "CLAUDE_CODE_OAUTH_TOKEN",
                                    value: tokenInput.trim(),
                                  });
                                  toast.success("Token updated");
                                  setTokenInput("");
                                } catch (err) {
                                  toast.error("Failed to save token");
                                }
                                setTokenSaving(false);
                              }}
                              disabled={!tokenInput.trim() || tokenSaving}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50 btn-press transition-all"
                            >
                              {tokenSaving ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Key className="w-3 h-3" />
                              )}
                              Update
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="p-2.5 rounded-md bg-bg/50 border border-border">
                        <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                          Suggested fix
                        </div>
                        <pre className="text-xs text-text/80 whitespace-pre-wrap font-mono">
                          {classified.remedy}
                        </pre>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      {classified.retryable && canRetry && (
                        <button
                          onClick={handleRetry}
                          disabled={actionLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50 btn-press transition-all"
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

      {/* Dependencies */}
      {(dependencies.length > 0 || dependents.length > 0) && (
        <div className="shrink-0 border-b border-border bg-bg px-4 py-2.5">
          <div className="max-w-5xl mx-auto">
            {dependencies.length > 0 && (
              <div className="mb-2">
                <h3 className="text-xs font-medium text-text-muted mb-1">
                  Depends on (
                  {
                    dependencies.filter(
                      (d: any) => d.state === "completed" || d.state === "pr_opened",
                    ).length
                  }
                  /{dependencies.length} complete)
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {dependencies.map((dep: any) => (
                    <Link
                      key={dep.id}
                      href={`/tasks/${dep.id}`}
                      className={cn(
                        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border",
                        dep.state === "completed" || dep.state === "pr_opened"
                          ? "border-green-500/30 text-green-400 bg-green-500/5"
                          : dep.state === "failed"
                            ? "border-red-500/30 text-red-400 bg-red-500/5"
                            : "border-border text-text-muted bg-bg-card",
                      )}
                    >
                      {dep.title}
                      <span className="opacity-60">{dep.state}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
            {dependents.length > 0 && (
              <div>
                <h3 className="text-xs font-medium text-text-muted mb-1">
                  Blocks ({dependents.length} task{dependents.length !== 1 ? "s" : ""})
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {dependents.map((dep: any) => (
                    <Link
                      key={dep.id}
                      href={`/tasks/${dep.id}`}
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border border-border text-text-muted bg-bg-card hover:bg-bg-hover"
                    >
                      {dep.title}
                      <span className="opacity-60">{dep.state}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Subtasks */}
      {(subtasks.length > 0 || task.state === "pr_opened" || task.state === "running") && (
        <div className="shrink-0 border-b border-border bg-bg px-4 py-2.5">
          <div className="max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-medium text-text-muted">
                Subtasks{" "}
                {subtasks.length > 0 &&
                  `(${subtasks.filter((s: any) => s.state === "completed").length}/${subtasks.length})`}
              </h3>
              <button
                onClick={() => setShowCreateSubtask(!showCreateSubtask)}
                className="text-xs text-primary hover:underline"
              >
                {showCreateSubtask ? "Cancel" : "+ Add subtask"}
              </button>
            </div>

            {/* Create subtask form */}
            {showCreateSubtask && (
              <div className="p-3 rounded-md border border-border bg-bg-card space-y-2 mb-2">
                <input
                  value={newSubtask.title}
                  onChange={(e) => setNewSubtask((s) => ({ ...s, title: e.target.value }))}
                  placeholder="Subtask title"
                  className="w-full px-3 py-1.5 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
                <textarea
                  value={newSubtask.prompt}
                  onChange={(e) => setNewSubtask((s) => ({ ...s, prompt: e.target.value }))}
                  placeholder="What should the agent do?"
                  rows={3}
                  className="w-full px-3 py-1.5 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y"
                />
                <div className="flex items-center gap-4">
                  <select
                    value={newSubtask.taskType}
                    onChange={(e) => setNewSubtask((s) => ({ ...s, taskType: e.target.value }))}
                    className="px-2 py-1 rounded-md bg-bg border border-border text-xs"
                  >
                    <option value="child">Child task</option>
                    <option value="step">Sequential step</option>
                    <option value="review">Code review</option>
                  </select>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newSubtask.blocksParent}
                      onChange={(e) =>
                        setNewSubtask((s) => ({ ...s, blocksParent: e.target.checked }))
                      }
                      className="w-3 h-3 rounded"
                    />
                    Blocks parent
                  </label>
                  <button
                    onClick={handleCreateSubtask}
                    disabled={actionLoading || !newSubtask.title.trim()}
                    className="px-3 py-1 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50 ml-auto btn-press transition-all"
                  >
                    Create & Queue
                  </button>
                </div>
              </div>
            )}

            {/* Subtask list */}
            {subtasks.length > 0 && (
              <div className="space-y-1">
                {subtasks.map((sub: any, idx: number) => {
                  const isStep = sub.taskType === "step";
                  const stepIndex = isStep
                    ? subtasks.filter((s: any) => s.taskType === "step").indexOf(sub) + 1
                    : 0;
                  return (
                    <Link
                      key={sub.id}
                      href={`/tasks/${sub.id}`}
                      className={cn(
                        "flex items-center gap-2 p-2 rounded-md border text-xs transition-colors hover:bg-bg-hover",
                        sub.taskType === "review"
                          ? "border-info/20 bg-info/5"
                          : isStep
                            ? sub.state === "completed"
                              ? "border-success/20 bg-success/5"
                              : sub.state === "failed"
                                ? "border-error/20 bg-error/5"
                                : ["running", "provisioning", "queued"].includes(sub.state)
                                  ? "border-primary/20 bg-primary/5"
                                  : "border-border bg-bg-card"
                            : sub.blocksParent
                              ? "border-warning/20 bg-warning/5"
                              : "border-border bg-bg-card",
                      )}
                    >
                      {sub.taskType === "review" ? (
                        <Bot className="w-3.5 h-3.5 text-info shrink-0" />
                      ) : isStep ? (
                        <span
                          className={cn(
                            "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0",
                            sub.state === "completed"
                              ? "bg-success/20 text-success"
                              : sub.state === "failed"
                                ? "bg-error/20 text-error"
                                : ["running", "provisioning", "queued"].includes(sub.state)
                                  ? "bg-primary/20 text-primary"
                                  : "bg-border text-text-muted",
                          )}
                        >
                          {stepIndex}
                        </span>
                      ) : sub.blocksParent ? (
                        <span className="w-3.5 h-3.5 text-warning shrink-0 text-center font-bold">
                          !
                        </span>
                      ) : (
                        <span className="w-3.5 h-3.5 text-text-muted shrink-0 text-center">•</span>
                      )}
                      <span className="truncate flex-1">{sub.title}</span>
                      {isStep && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-bg-hover text-text-muted shrink-0">
                          step
                        </span>
                      )}
                      {sub.blocksParent && !isStep && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-warning/10 text-warning shrink-0">
                          blocking
                        </span>
                      )}
                      <StateBadge state={sub.state} />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main content: logs + sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Log panel */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Log viewer + events toggle */}
          <div className="shrink-0 flex items-center justify-end px-4 py-1 border-b border-border bg-bg">
            <button
              onClick={() => setShowTimeline(!showTimeline)}
              className={cn(
                "px-2 py-0.5 rounded text-xs transition-colors",
                showTimeline ? "bg-primary/10 text-primary" : "text-text-muted hover:bg-bg-hover",
              )}
            >
              Timeline
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
                className="flex-1 px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
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

        {/* Timeline sidebar */}
        {showTimeline && (
          <div className="w-80 shrink-0 border-l border-border overflow-auto bg-bg-card flex flex-col">
            <div className="flex items-center gap-1 p-2 border-b border-border">
              <button
                onClick={() => setSidebarTab("pipeline")}
                className={cn(
                  "px-2.5 py-1 rounded text-xs transition-colors",
                  sidebarTab === "pipeline"
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-text-muted hover:bg-bg-hover",
                )}
              >
                Pipeline
              </button>
              <button
                onClick={() => setSidebarTab("activity")}
                className={cn(
                  "px-2.5 py-1 rounded text-xs transition-colors",
                  sidebarTab === "activity"
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-text-muted hover:bg-bg-hover",
                )}
              >
                Activity
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              {sidebarTab === "pipeline" ? (
                <PipelineTimeline task={task} events={events} subtasks={subtasks} />
              ) : (
                <ActivityFeed taskId={id} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
