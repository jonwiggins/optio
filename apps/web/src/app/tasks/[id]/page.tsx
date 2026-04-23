"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState, useEffect } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { useTask } from "@/hooks/use-task";
import { LogViewer } from "@/components/log-viewer";
import { PipelineTimeline } from "@/components/pipeline-timeline";
import { ActivityFeed } from "@/components/activity-feed";
import { DetailHeader } from "@/components/detail-header";
import { PrStatusBar } from "@/components/pr-status-bar";
import { ChatComposer } from "@/components/chat-box";
import { StateBadge } from "@/components/state-badge";
import { TokenRefreshBanner } from "@/components/token-refresh-banner";
import { api } from "@/lib/api-client";
import { ErrorBoundary } from "@/components/error-boundary";
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
  Moon,
  Bot,
  Send,
  AlertCircle,
  AlertTriangle,
  Eye,
  Plus,
  X,
  CheckCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useOptioChatStore } from "@/hooks/use-optio-chat";
import { AddDependencyDialog } from "@/components/add-dependency-dialog";

export default function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { task, events, pendingReason, pipelineProgress, stallInfo, loading, error, refresh } =
    useTask(id);
  usePageTitle(task?.title ?? "Task");

  // Legacy redirect: /tasks/:id URLs that resolve to a pr_reviews row are
  // PR reviews — send the user to the /reviews/:id detail page.
  useEffect(() => {
    if (!error) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getPrReview(id);
        if (!cancelled && res?.review) {
          router.replace(`/reviews/${id}`);
        }
      } catch {
        // Not a PR review — leave the error UI in place.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [error, id, router]);
  const [actionLoading, setActionLoading] = useState(false);
  const [resumePrompt, setResumePrompt] = useState("");
  const [showTimeline, setShowTimeline] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"pipeline" | "activity">("pipeline");
  const [subtasks, setSubtasks] = useState<any[]>([]);
  const [dependencies, setDependencies] = useState<any[]>([]);
  const [dependents, setDependents] = useState<any[]>([]);
  const [showCreateSubtask, setShowCreateSubtask] = useState(false);
  const [showAddDependency, setShowAddDependency] = useState(false);
  const optioChat = useOptioChatStore();
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

  const [messageInput, setMessageInput] = useState("");
  const [messageSending, setMessageSending] = useState(false);
  const [userMessages, setUserMessages] = useState<
    { text: string; timestamp: string; status: "sending" | "sent" | "failed" }[]
  >([]);

  const handleSendMessage = async (mode: "soft" | "interrupt" = "soft") => {
    if (!messageInput.trim()) return;
    const text = messageInput;
    setMessageSending(true);
    setUserMessages((prev) => [
      ...prev,
      { text, timestamp: new Date().toISOString(), status: "sending" },
    ]);
    try {
      await api.sendTaskMessage(id, text, mode);
      setMessageInput("");
      setUserMessages((prev) =>
        prev.map((m) => (m.text === text && m.status === "sending" ? { ...m, status: "sent" } : m)),
      );
      toast.success(mode === "interrupt" ? "Interrupt sent" : "Message sent");
    } catch (err) {
      setUserMessages((prev) =>
        prev.map((m) =>
          m.text === text && m.status === "sending" ? { ...m, status: "failed" } : m,
        ),
      );
      toast.error(err instanceof Error ? err.message : "Failed to send message");
    }
    setMessageSending(false);
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

  const handleApprovePlan = async () => {
    setActionLoading(true);
    try {
      await api.resumeTask(
        id,
        "Plan approved. Proceed with implementation following your plan above.",
      );
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve plan");
    }
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
  const canMessage = task.state === "running" && task.agentType === "claude-code";
  const canForceRestart = ["needs_attention", "failed", "pr_opened"].includes(task.state);

  // Detect plan review state: needs_attention with plan_review trigger
  const isPlanReview =
    task.state === "needs_attention" &&
    events.length > 0 &&
    events[events.length - 1]?.trigger === "plan_review";

  // (log filtering is handled by LogViewer component)

  return (
    <div className="flex flex-col h-full">
      <DetailHeader
        title={task.title}
        state={task.state}
        isStalled={stallInfo?.isStalled}
        metaItems={[
          <>
            <GitBranch className="w-3 h-3" />
            {repoName}
          </>,
          <span className="flex items-center gap-1 capitalize">
            <Bot className="w-3 h-3" />
            {task.agentType.replace("-", " ")}
          </span>,
          <>
            <Clock className="w-3 h-3" />
            {formatRelativeTime(task.createdAt)}
          </>,
        ]}
        rightSlot={
          <button
            onClick={refresh}
            className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        }
        actions={
          <>
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-success/10 text-success text-xs hover:bg-success/20 transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                PR #{task.prNumber ?? "?"}
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
              onClick={() => {
                const prefill =
                  task.state === "failed" && task.errorMessage
                    ? `Task "${task.title}" (#${task.id.slice(0, 8)}) failed with: ${task.errorMessage.slice(0, 200)}`
                    : `Help me with task "${task.title}" (#${task.id.slice(0, 8)})`;
                optioChat.setPrefillInput(prefill);
                optioChat.open();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 transition-colors"
            >
              <Bot className="w-3 h-3" />
              Ask Optio
            </button>
          </>
        }
      />

      {/* Pending reason */}
      {pendingReason && (
        <div
          className={cn(
            "shrink-0 border-b px-4 py-2.5",
            pendingReason.includes("off-peak")
              ? "border-info/20 bg-info/5"
              : "border-warning/20 bg-warning/5",
          )}
        >
          <div className="max-w-5xl mx-auto flex items-center gap-2 text-xs">
            {pendingReason.includes("off-peak") ? (
              <Moon className="w-3.5 h-3.5 text-info shrink-0" />
            ) : (
              <Clock className="w-3.5 h-3.5 text-warning shrink-0" />
            )}
            <span
              className={pendingReason.includes("off-peak") ? "text-info/80" : "text-warning/80"}
            >
              {pendingReason}
            </span>
            {pendingReason.includes("off-peak") && task?.state === "queued" && (
              <button
                disabled={actionLoading}
                onClick={async () => {
                  setActionLoading(true);
                  try {
                    await api.runNowTask(id);
                    await refresh();
                    toast.success("Task will run immediately");
                  } catch {
                    toast.error("Failed to override off-peak hold");
                  }
                  setActionLoading(false);
                }}
                className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-all shrink-0"
              >
                <Play className="w-3 h-3" />
                Run Now
              </button>
            )}
          </div>
        </div>
      )}

      {/* Stall warning banner */}
      {stallInfo?.isStalled && task?.state === "running" && (
        <div className="shrink-0 border-b border-warning/20 bg-warning/5">
          <div className="max-w-5xl mx-auto px-4 py-2.5 flex items-center gap-2 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
            <span className="text-warning/80">
              Agent looks stuck. No activity for{" "}
              {stallInfo.silentForMs >= 60000
                ? `${Math.floor(stallInfo.silentForMs / 60000)}m ${Math.floor((stallInfo.silentForMs % 60000) / 1000)}s`
                : `${Math.floor(stallInfo.silentForMs / 1000)}s`}
              .{stallInfo.lastLogSummary ? ` Last action: ${stallInfo.lastLogSummary}` : ""}
            </span>
            <span
              className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md bg-text-muted/10 text-text-muted/50 text-[10px] cursor-not-allowed"
              title="Coming soon — depends on interactive messaging feature"
            >
              Send a nudge
            </span>
            <button
              disabled={actionLoading}
              onClick={handleCancel}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-error/10 text-error hover:bg-error/20 transition-all shrink-0"
            >
              <XCircle className="w-3 h-3" />
              Force fail
            </button>
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

      {/* Error panel — only for terminal failures and needs_attention. A task
          in pr_opened state is healthy (the PR is being monitored); a stale
          errorMessage there shouldn't paint it red. */}
      {task.errorMessage &&
        (isTerminal || task.state === "needs_attention") &&
        (() => {
          const classified = classifyError(task.errorMessage);
          if (classified.category === "auth") {
            return (
              <div className="shrink-0 border-b border-border bg-bg-card">
                <div className="max-w-5xl mx-auto px-4 py-3">
                  <TokenRefreshBanner onSaved={refresh} />
                </div>
              </div>
            );
          }
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

      {/* PR Status — also hosts the Timeline toggle so both pages put it in
          the same place. The row always renders to give Timeline a stable home. */}
      <div className="shrink-0 border-b border-border bg-bg-card px-4 py-2">
        <div className="max-w-5xl mx-auto">
          <PrStatusBar
            checksStatus={task.prChecksStatus}
            reviewStatus={task.prReviewStatus}
            prState={task.prState}
            actions={
              <>
                {task.costUsd && (
                  <span className="text-text-muted">
                    Cost: ${parseFloat(task.costUsd).toFixed(4)}
                  </span>
                )}
                {task.state === "pr_opened" && (
                  <button
                    onClick={async () => {
                      setActionLoading(true);
                      try {
                        await api.launchReview(id);
                        toast.success("Review agent launched");
                        refresh();
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Failed to launch review");
                      }
                      setActionLoading(false);
                    }}
                    disabled={actionLoading}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 disabled:opacity-50"
                  >
                    <Eye className="w-3 h-3" />
                    Request Review
                  </button>
                )}
                <button
                  onClick={() => setShowTimeline(!showTimeline)}
                  className={cn(
                    "px-2 py-0.5 rounded text-xs transition-colors",
                    showTimeline
                      ? "bg-primary/10 text-primary"
                      : "text-text-muted hover:bg-bg-hover",
                  )}
                >
                  Timeline
                </button>
              </>
            }
          />
          {task.prReviewStatus === "changes_requested" && task.prReviewComments && (
            <div className="mt-2 p-2 rounded-md bg-warning/5 border border-warning/20 text-xs">
              <div className="font-medium text-warning mb-1">Review feedback:</div>
              <pre className="text-text-muted whitespace-pre-wrap">{task.prReviewComments}</pre>
            </div>
          )}
        </div>
      </div>

      {/* Dependencies */}
      <div className="shrink-0 border-b border-border bg-bg px-4 py-2.5">
        <div className="max-w-5xl mx-auto">
          <div className={dependencies.length > 0 ? "mb-2" : ""}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-medium text-text-muted">
                {dependencies.length > 0
                  ? `Depends on (${dependencies.filter((d: any) => d.state === "completed" || d.state === "pr_opened").length}/${dependencies.length} complete)`
                  : "Dependencies"}
              </h3>
              <button
                onClick={() => setShowAddDependency(true)}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus className="w-3 h-3" />
                Add Dependency
              </button>
            </div>
            {dependencies.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {dependencies.map((dep: any) => (
                  <div
                    key={dep.id}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border group",
                      dep.state === "completed" || dep.state === "pr_opened"
                        ? "border-green-500/30 text-green-400 bg-green-500/5"
                        : dep.state === "failed"
                          ? "border-red-500/30 text-red-400 bg-red-500/5"
                          : "border-border text-text-muted bg-bg-card",
                    )}
                  >
                    <Link href={`/tasks/${dep.id}`} className="inline-flex items-center gap-1.5">
                      {dep.title}
                      <span className="opacity-60">{dep.state}</span>
                    </Link>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Remove dependency on "${dep.title}"?`)) return;
                        try {
                          await api.removeTaskDependency(id, dep.id);
                          setDependencies((prev) => prev.filter((d: any) => d.id !== dep.id));
                          toast.success("Dependency removed");
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : "Failed to remove dependency",
                          );
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-hover transition-opacity"
                      title="Remove dependency"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted/60">
                No dependencies. Add one to ensure this task waits for another to complete.
              </p>
            )}
          </div>
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

      {/* Add Dependency Dialog */}
      {showAddDependency && (
        <AddDependencyDialog
          taskId={id}
          existingDependencyIds={dependencies.map((d: any) => d.id)}
          onAdd={async (depId) => {
            await api.addTaskDependencies(id, [depId]);
            const res = await api.getTaskDependencies(id);
            setDependencies(res.dependencies);
            setShowAddDependency(false);
            toast.success("Dependency added");
          }}
          onClose={() => setShowAddDependency(false)}
        />
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
          {/* Log content via LogViewer */}
          <div className="flex-1 overflow-hidden">
            <ErrorBoundary label="Log viewer">
              <LogViewer taskId={id} userMessages={userMessages} />
            </ErrorBoundary>
          </div>

          {/* Message / Resume bar */}
          <div className="shrink-0 border-t border-border bg-bg-card px-4 py-2.5">
            {canMessage ? (
              /* Mid-task messaging bar (running claude-code tasks) */
              <ChatComposer
                value={messageInput}
                onChange={setMessageInput}
                onSend={() => handleSendMessage("soft")}
                onInterrupt={() => handleSendMessage("interrupt")}
                sending={messageSending}
                placeholder="Send a message to the running agent..."
                sendLabel="Send"
                interruptLabel="Stop"
              />
            ) : isPlanReview && canResume ? (
              /* Plan review bar */
              <div className="space-y-2">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-sm">
                  <Eye className="w-4 h-4 text-primary shrink-0" />
                  <span className="text-primary font-medium">
                    Plan ready for review — check the agent output above
                  </span>
                </div>
                <div className="flex gap-2 items-center">
                  <input
                    value={resumePrompt}
                    onChange={(e) => setResumePrompt(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleResume()}
                    placeholder="Send feedback or modifications to the plan..."
                    className="flex-1 px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                  />
                  <button
                    onClick={handleResume}
                    disabled={!resumePrompt.trim() || actionLoading}
                    title="Send feedback to the agent"
                    className="px-3 py-2 rounded-md text-sm font-medium transition-colors bg-bg-hover text-text hover:bg-bg-hover/80 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    <Send className="w-4 h-4" />
                    <span className="hidden sm:inline">Send Feedback</span>
                  </button>
                  <button
                    onClick={handleApprovePlan}
                    disabled={actionLoading}
                    title="Approve the plan and start implementation"
                    className="px-3 py-2 rounded-md text-sm font-medium transition-colors bg-success text-white hover:bg-success/90 disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    {actionLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <CheckCircle className="w-4 h-4" />
                    )}
                    <span className="hidden sm:inline">Approve & Execute</span>
                  </button>
                </div>
              </div>
            ) : (
              /* Resume bar (for non-running or resumable tasks) */
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
            )}
            {isTerminal && !task.sessionId && !canMessage && (
              <p className="text-[10px] text-text-muted/50 mt-1">
                Resume unavailable — no session was captured for this task.
              </p>
            )}
          </div>
        </div>

        {/* Timeline sidebar */}
        {showTimeline && (
          <div className="hidden md:flex w-80 shrink-0 border-l border-border overflow-auto bg-bg-card flex-col">
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
                <ErrorBoundary label="Pipeline timeline">
                  <PipelineTimeline task={task} events={events} subtasks={subtasks} />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary label="Activity feed">
                  <ActivityFeed taskId={id} />
                </ErrorBoundary>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
