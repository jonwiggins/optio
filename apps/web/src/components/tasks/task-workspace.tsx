"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect, type ComponentProps, type ReactNode } from "react";
import { useTask } from "@/hooks/use-task";
import { LogViewer } from "@/components/log-viewer";
import { PipelineTimeline } from "@/components/pipeline-timeline";
import { ActivityFeed } from "@/components/activity-feed";
import { DetailHeader } from "@/components/detail-header";
import { PrStatusBar } from "@/components/pr-status-bar";
import { TaskPrs } from "./task-prs";
import { ChatComposer } from "@/components/chat-box";
import { TokenRefreshBanner, GitHubTokenBanner } from "@/components/token-refresh-banner";
import { TerminalPane } from "@/components/local/terminal-pane";
import { api } from "@/lib/api-client";
import { ErrorBoundary } from "@/components/error-boundary";
import { classifyError, getProviderCatalog, providerForAgentType } from "@optio/shared";
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
  ArrowLeft,
  Send,
  AlertCircle,
  AlertTriangle,
  Eye,
  CheckCircle,
  Laptop,
  MoreHorizontal,
} from "lucide-react";
import { BRAND_LABEL, PrIcon, TriggerIcon, brandFor } from "@/components/brand-icon";
import { toast } from "sonner";
import { useOptioChatStore } from "@/hooks/use-optio-chat";
import { Button } from "@/components/ui/button";
import { SplitPane } from "@/components/split-pane";
import { Segmented } from "@/components/ui/segmented";
import { SectionCard } from "@/components/ui/section-card";
import { Dialog } from "@/components/ui/dialog";
import { LogMarkdown } from "@/components/log-markdown";
import { AgentIcon } from "@/components/brand-icon";
import { TaskRelations } from "./task-relations";
import { RunAgentPolicy } from "./run-agent-policy";
import { TaskLocalSession } from "./task-local-session";
import { inputClass } from "@/components/ui/input";

type LocalPane = Omit<ComponentProps<typeof TerminalPane>, "onTitle" | "embedded">;

/** PR follow-up is a workflow status, not a failed agent execution. */
const PR_ATTENTION: Record<string, { title: string; description: string }> = {
  ci_failing_needs_attention: {
    title: "PR checks need attention",
    description: "Review the failing checks before continuing work on this pull request.",
  },
  pr_conflicts_needs_attention: {
    title: "PR has merge conflicts",
    description: "Resolve the conflicts before this pull request can be merged.",
  },
  review_changes_needs_attention: {
    title: "PR review requested changes",
    description: "Review the feedback before continuing work on this pull request.",
  },
};

/** Both task links and task-backed Local sessions render this workspace. */
export function TaskWorkspace({
  id,
  localPane,
  onTitle,
  onTask,
  sessionPicker,
  currentSessionHref,
}: {
  id: string;
  localPane?: LocalPane;
  onTitle?: (title: string) => void;
  onTask?: (task: any) => void;
  sessionPicker?: ReactNode;
  currentSessionHref?: string;
}) {
  const router = useRouter();
  const { task, events, pendingReason, pipelineProgress, stallInfo, loading, error, refresh } =
    useTask(id);
  useEffect(() => {
    if (task?.title) onTitle?.(task.title);
  }, [task?.title, onTitle]);

  useEffect(() => {
    if (task) onTask?.(task);
  }, [task, onTask]);

  // Legacy redirect: /tasks/:id URLs that resolve to a pr_reviews row are
  // PR reviews — send the user to the /reviews/:id detail page.
  useEffect(() => {
    if (!error || localPane) return;
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
  }, [error, id, router, localPane]);
  const [actionLoading, setActionLoading] = useState(false);
  const [resumePrompt, setResumePrompt] = useState("");
  const [sidebarTab, setSidebarTab] = useState<"overview" | "pipeline" | "activity">("overview");
  const [showActions, setShowActions] = useState(false);
  const [subtasks, setSubtasks] = useState<any[]>([]);
  const optioChat = useOptioChatStore();
  // Auto-refresh task state periodically when active
  useEffect(() => {
    if (!task) return;
    const isActive = ["running", "provisioning", "queued", "pr_opened", "needs_attention"].includes(
      task.state,
    );
    if (!isActive) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [task?.state, refresh]);

  const handleCancel = async () => {
    setActionLoading(true);
    try {
      await api.cancelTask(id);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update task");
    }
    setActionLoading(false);
  };

  const handleRetry = async () => {
    setActionLoading(true);
    try {
      await api.retryTask(id);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update task");
    }
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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update task");
    }
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading task...
      </div>
    );
  }

  if (!task) {
    // A deleted or inaccessible task must not hide a still-readable Local session.
    if (localPane) return <TerminalPane {...localPane} onTitle={onTitle} />;
    return (
      <div className="flex items-center justify-center h-full text-error">
        {error ?? "Task not found"}
      </div>
    );
  }

  const repoName = task.repoUrl.replace(/.*\/\/[^/]+\//, "").replace(/\.git$/, "");
  // Local tasks run in a terminal on the owner's machine: the session is
  // embedded in place of the pod log viewer, and the chat composer (which
  // writes to the pod agent's stdin) gives way to typing in the terminal.
  const isLocalTask = task.runTarget === "local";
  const modelField = getProviderCatalog(providerForAgentType(task.agentType))?.modelField;
  const model = task.modelUsed ?? (modelField ? task.metadata?.agentOptions?.[modelField] : null);
  const isActive = ["running", "provisioning", "queued"].includes(task.state);
  const isTerminal = ["completed", "failed", "cancelled"].includes(task.state);
  const prAttention =
    task.state === "needs_attention" ? PR_ATTENTION[task.errorMessage] : undefined;
  const canCancel = ["running", "queued", "provisioning", "needs_attention"].includes(task.state);
  const canRetry = ["failed", "cancelled"].includes(task.state);
  // Backfilled ticket tasks (initial provider sweep) sit in pending until the
  // user starts them; pipeline steps stay pending until their deps complete.
  const canStart = task.state === "pending" && task.taskType !== "step";
  const canResume =
    !isLocalTask && ["needs_attention", "failed"].includes(task.state) && !!task.sessionId;
  // Chat composer shows whenever the message endpoint will accept a message:
  // - running + claude-code (mid-turn delivery via stream-json stdin), or
  // - stopped-but-resumable (needs_attention / pr_opened / failed / cancelled)
  //   — the message becomes the resume prompt for any agent type.
  const canMessageRunning =
    task.state === "running" && task.agentType === "claude-code" && !isLocalTask;
  const canMessageStopped = ["needs_attention", "pr_opened", "failed", "cancelled"].includes(
    task.state,
  );
  const canMessage = canMessageRunning || canMessageStopped;
  const canForceRestart = ["needs_attention", "failed", "pr_opened"].includes(task.state);

  // Detect plan review state: needs_attention with plan_review trigger
  const isPlanReview =
    task.state === "needs_attention" &&
    events.length > 0 &&
    events[events.length - 1]?.trigger === "plan_review";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="task-workspace">
      <DetailHeader
        compact
        title={task.title}
        state={task.state}
        prUrl={task.prUrl}
        isStalled={!isLocalTask && stallInfo?.isStalled}
        metaItems={[
          <Link href="/work" className="inline-flex items-center gap-1 hover:text-primary">
            <ArrowLeft className="h-3 w-3" /> Work
          </Link>,
          <>
            <GitBranch className="h-3 w-3" />
            {repoName}
          </>,
          <span className="inline-flex items-center gap-1.5 capitalize">
            <AgentIcon runtime={task.agentType} className="h-3.5 w-3.5" />
            {task.agentType.replaceAll("-", " ")}
          </span>,
          <>
            <Clock className="h-3 w-3" />
            {formatRelativeTime(task.createdAt)}
          </>,
        ]}
        rightSlot={
          <>
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text"
              >
                <PrIcon state={task.prState} className="h-3.5 w-3.5" />
                PR #{task.prNumber ?? "?"}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {canStart && (
              <Button size="sm" onClick={handleRetry} disabled={actionLoading}>
                <Play />
                Start
              </Button>
            )}
            {canRetry && (
              <Button size="sm" onClick={handleRetry} disabled={actionLoading}>
                <RotateCcw />
                Retry
              </Button>
            )}
            {canCancel && (
              <Button variant="ghost" size="sm" onClick={handleCancel} disabled={actionLoading}>
                <XCircle />
                Cancel task
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={refresh} aria-label="Refresh task">
              <RefreshCw />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowActions(true)}
              aria-label="Task actions"
            >
              <MoreHorizontal />
            </Button>
          </>
        }
      />
      {sessionPicker && (
        <div className="shrink-0 border-b border-border px-4 py-2">{sessionPicker}</div>
      )}
      {error && (
        <div
          role="status"
          className="shrink-0 border-b border-warning/20 bg-warning/5 px-4 py-2 text-xs text-warning"
        >
          Task status could not be refreshed. Showing the last known state.{" "}
          <button className="underline" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {task.errorMessage && (task.state === "failed" || task.state === "needs_attention") && (
        <div
          role="status"
          className="shrink-0 border-b border-warning/20 bg-warning/5 px-4 py-2 text-xs text-warning"
        >
          {prAttention ? (
            <>
              <span className="font-medium">{prAttention.title}.</span> {prAttention.description}{" "}
              {task.prUrl && (
                <a
                  href={task.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Open pull request
                </a>
              )}
            </>
          ) : (
            <>
              {classifyError(task.errorMessage).title}. See Details for the error and recovery
              options.
            </>
          )}
        </div>
      )}
      {localPane && task.localTerminalId && localPane.terminalId !== task.localTerminalId && (
        <div className="border-b border-border bg-bg-card px-4 py-2 text-xs text-text-muted">
          Viewing an earlier session for this task.{" "}
          <Link href={currentSessionHref ?? `/work/${id}`} className="text-primary hover:underline">
            Open current session
          </Link>
        </div>
      )}
      {/* Pending reason */}
      {pendingReason && (
        <div
          className={cn(
            "shrink-0 border-b py-2.5",
            pendingReason.includes("off-peak")
              ? "border-info/20 bg-info/5"
              : "border-warning/20 bg-warning/5",
          )}
        >
          <div className="page-column flex items-center gap-2 text-xs">
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
      {!isLocalTask && stallInfo?.isStalled && task?.state === "running" && (
        <div className="shrink-0 border-b border-warning/20 bg-warning/5">
          <div className="page-column py-2.5 flex items-center gap-2 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
            <span className="text-warning/80">
              Agent looks stuck. No activity for{" "}
              {stallInfo.silentForMs >= 60000
                ? `${Math.floor(stallInfo.silentForMs / 60000)}m ${Math.floor((stallInfo.silentForMs % 60000) / 1000)}s`
                : `${Math.floor(stallInfo.silentForMs / 1000)}s`}
              .{stallInfo.lastLogSummary ? ` Last action: ${stallInfo.lastLogSummary}` : ""}
            </span>
            <button
              disabled={actionLoading}
              onClick={handleCancel}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-error/10 text-error hover:bg-error/20 transition-all shrink-0"
            >
              <XCircle className="w-3 h-3" />
              Cancel task
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <SplitPane
          leftLabel="Session"
          rightLabel="Details"
          defaultLeftPct={70}
          storageKey="optio-task-detail-split"
          left={
            <>
              {" "}
              {/* Log panel */}
              <div className="h-full min-h-0 min-w-0 flex flex-col">
                {/* Log content via LogViewer — or the live local session for a
              task running on the owner's machine */}
                <div className="flex-1 min-h-0 overflow-hidden">
                  {isLocalTask && (localPane?.terminalId || task.localTerminalId) ? (
                    <ErrorBoundary label="Local session">
                      <TaskLocalSession task={task} pane={localPane} />
                    </ErrorBoundary>
                  ) : isLocalTask ? (
                    <div className="h-full flex items-center justify-center text-sm text-text-muted px-6 text-center">
                      <span>
                        <Laptop className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
                        This task runs on your machine. Its session appears here once the daemon
                        picks it up
                        {task.localDir ? (
                          <>
                            {" "}
                            (<span className="font-mono">{task.localDir}</span>)
                          </>
                        ) : null}
                        .
                      </span>
                    </div>
                  ) : (
                    <ErrorBoundary label="Log viewer">
                      <LogViewer embedded taskId={id} userMessages={userMessages} />
                    </ErrorBoundary>
                  )}
                </div>

                {/* Message / Resume bar */}
                {!isLocalTask && (
                  <div className="shrink-0 border-t border-border bg-bg-card px-4 py-2.5">
                    {canMessage && !isPlanReview ? (
                      /* Unified chat bar. For running claude-code tasks the message is
                 delivered mid-turn via stream-json stdin; for stopped tasks
                 (needs_attention / pr_opened / failed / cancelled) it resumes
                 the agent with the message as the new prompt. */
                      <ChatComposer
                        value={messageInput}
                        onChange={setMessageInput}
                        onSend={() => handleSendMessage("soft")}
                        onInterrupt={
                          canMessageRunning ? () => handleSendMessage("interrupt") : undefined
                        }
                        sending={messageSending}
                        placeholder={
                          canMessageRunning
                            ? "Send a message to the running agent..."
                            : "Resume the agent with a message..."
                        }
                        sendLabel={canMessageRunning ? "Send" : "Resume"}
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
                            className={inputClass({ className: "flex-1" })}
                          />
                          <Button
                            variant="secondary"
                            onClick={handleResume}
                            disabled={!resumePrompt.trim() || actionLoading}
                            title="Send feedback to the agent"
                          >
                            <Send />
                            <span className="hidden sm:inline">Send Feedback</span>
                          </Button>
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
                          className={inputClass({
                            className: "flex-1 disabled:cursor-not-allowed",
                          })}
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
                )}
              </div>
            </>
          }
          right={
            <div className="flex h-full min-h-0 flex-col bg-bg-subtle/30">
              <div className="shrink-0 border-b border-border/70 p-3">
                <Segmented
                  value={sidebarTab}
                  onChange={setSidebarTab}
                  aria-label="Task details"
                  options={[
                    { value: "overview", label: "Overview" },
                    { value: "pipeline", label: "Pipeline" },
                    { value: "activity", label: "Activity" },
                  ]}
                />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
                <div className={cn("space-y-3", sidebarTab !== "overview" && "hidden")}>
                  {/* Pipeline progress */}
                  {pipelineProgress && (
                    <div className="rounded-xl border border-border bg-bg-card py-3">
                      <div className="px-4">
                        <div className="flex items-center gap-3 text-xs">
                          <span className="text-text-muted font-medium">
                            Pipeline: Step {pipelineProgress.currentStepIndex} of{" "}
                            {pipelineProgress.totalSteps}
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
                    !prAttention &&
                    (task.state === "failed" || task.state === "needs_attention") &&
                    (() => {
                      const classified = classifyError(task.errorMessage);
                      if (classified.recovery === "github-token") {
                        return (
                          <div className="rounded-xl border border-border bg-bg-card">
                            <div className="px-4 py-3">
                              <GitHubTokenBanner onSaved={refresh} />
                            </div>
                          </div>
                        );
                      }
                      if (classified.category === "auth" && !classified.recovery) {
                        return (
                          <div className="rounded-xl border border-border bg-bg-card">
                            <div className="px-4 py-3">
                              <TokenRefreshBanner onSaved={refresh} />
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div className="rounded-xl border border-error/20 bg-error/5">
                          <div className="px-4 py-3">
                            <div className="flex items-start gap-3">
                              <AlertCircle className="w-5 h-5 text-error shrink-0 mt-0.5" />
                              <div className="min-w-0 flex-1 space-y-2">
                                <div>
                                  <h3 className="text-sm font-medium text-error">
                                    {classified.title}
                                  </h3>
                                  <p className="text-xs text-error/70 mt-0.5">
                                    {classified.description}
                                  </p>
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
                                    <Button
                                      size="sm"
                                      onClick={handleRetry}
                                      disabled={actionLoading}
                                      className="btn-press"
                                    >
                                      <RotateCcw />
                                      Retry Task
                                    </Button>
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

                  <SectionCard label="Work">
                    <dl className="space-y-3 text-xs">
                      <Fact
                        label="Where"
                        value={isLocalTask ? (task.localDir ?? "Your machine") : "Optio pod"}
                      />
                      <Fact label="Base branch" value={task.repoBranch} />
                      <Fact
                        label="Who"
                        value={[task.agentType, model].filter(Boolean).join(" · ")}
                      />
                      <Fact
                        label="Then"
                        value={
                          task.autoResume
                            ? task.autoMerge === false
                              ? "Works until ready to merge"
                              : "Works until merged"
                            : "Review the result"
                        }
                      />
                      <Fact
                        label="Started"
                        value={
                          task.startedAt ? new Date(task.startedAt).toLocaleString() : "Not started"
                        }
                      />
                      {task.completedAt && (
                        <Fact
                          label="Finished"
                          value={new Date(task.completedAt).toLocaleString()}
                        />
                      )}
                      {task.costUsd != null && (
                        <Fact label="Cost" value={`$${Number(task.costUsd).toFixed(4)}`} />
                      )}
                    </dl>
                    {task.ticketSource && (
                      <div className="mt-3">
                        <TicketChip task={task} />
                      </div>
                    )}
                  </SectionCard>
                  {task.resultSummary && (
                    <SectionCard label="Result">
                      <LogMarkdown content={task.resultSummary} />
                    </SectionCard>
                  )}
                  <SectionCard label="Prompt">
                    <details>
                      <summary className="cursor-pointer text-xs text-primary">
                        Read task instructions
                      </summary>
                      <div className="mt-3 text-xs">
                        <LogMarkdown content={task.prompt} />
                      </div>
                    </details>
                  </SectionCard>
                  {/* The agent policy this run started with (docs/agent-policy.md). */}
                  <RunAgentPolicy runId={task.id} />
                  <SectionCard label="Pull requests">
                    {" "}
                    <PrStatusBar
                      checksStatus={task.prChecksStatus}
                      reviewStatus={task.prReviewStatus}
                      prState={task.prState}
                      actions={
                        <>
                          {task.state === "pr_opened" && (
                            <button
                              onClick={async () => {
                                setActionLoading(true);
                                try {
                                  await api.launchReview(id);
                                  toast.success("Review agent launched");
                                  refresh();
                                } catch (err) {
                                  toast.error(
                                    err instanceof Error ? err.message : "Failed to launch review",
                                  );
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
                        </>
                      }
                    />
                    {task.repoUrl && task.taskType !== "review" && (
                      <TaskPrs
                        taskId={task.id}
                        prs={task.prs ?? []}
                        onChange={refresh}
                        repoUrl={task.repoUrl}
                      />
                    )}
                    {task.prReviewStatus === "changes_requested" && task.prReviewComments && (
                      <div className="mt-2 p-2 rounded-md bg-warning/5 border border-warning/20 text-xs">
                        <div className="font-medium text-warning mb-1">Review feedback:</div>
                        <pre className="text-text-muted whitespace-pre-wrap">
                          {task.prReviewComments}
                        </pre>
                      </div>
                    )}
                  </SectionCard>
                  <TaskRelations task={task} refresh={refresh} onSubtasks={setSubtasks} />
                </div>
                {sidebarTab === "pipeline" && (
                  <ErrorBoundary label="Pipeline timeline">
                    <PipelineTimeline task={task} events={events} subtasks={subtasks} />
                  </ErrorBoundary>
                )}
                {sidebarTab === "activity" && (
                  <ErrorBoundary label="Activity feed">
                    <ActivityFeed taskId={id} />
                  </ErrorBoundary>
                )}
              </div>
            </div>
          }
        />
      </div>
      {showActions && (
        <Dialog title="Task actions" onClose={() => setShowActions(false)} busy={actionLoading}>
          <div className="space-y-4">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                optioChat.setPrefillInput(
                  `Help me with task "${task.title}" (#${task.id.slice(0, 8)})`,
                );
                optioChat.open();
                setShowActions(false);
              }}
            >
              <Bot />
              Ask Optio
            </Button>
            {canForceRestart && (
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={actionLoading}
                  onClick={handleForceRestart}
                >
                  <Play />
                  Attempt resume
                </Button>
                <p className="mt-1.5 text-xs text-text-muted">
                  Start a fresh agent session on the existing PR branch.
                </p>
              </div>
            )}
            <div className="border-t border-border pt-4">
              <Button variant="danger" size="sm" disabled={actionLoading} onClick={handleForceRedo}>
                <RotateCcw />
                Force redo
              </Button>
              <p className="mt-1.5 text-xs text-text-muted">
                Clear this task’s logs and results, then run it again from scratch.
              </p>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3">
      <dt className="text-text-muted">{label}</dt>
      <dd className="break-words [overflow-wrap:anywhere] text-text">{value}</dd>
    </div>
  );
}

/** The ticket a task was started from (GitHub issue, Linear ticket, …), with its tracker's mark. */
function TicketChip({ task }: { task: any }) {
  const brand = brandFor(task.ticketSource);
  const label = `${brand ? BRAND_LABEL[brand] : task.ticketSource} ${
    task.ticketExternalId
      ? /[#!/-]/.test(task.ticketExternalId)
        ? task.ticketExternalId
        : `#${task.ticketExternalId}`
      : "ticket"
  }`;
  const url = typeof task.metadata?.ticketUrl === "string" ? task.metadata.ticketUrl : null;
  const body = (
    <>
      <TriggerIcon type="ticket" source={task.ticketSource} className="w-3 h-3" />
      <span className="font-mono">{label}</span>
    </>
  );
  const cls =
    "flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-bg-card text-text-muted text-xs";
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Started from ${label}`}
      className={cls + " hover:text-text hover:border-border-strong transition-colors"}
    >
      {body}
    </a>
  ) : (
    <span className={cls} title={`Started from ${label}`}>
      {body}
    </span>
  );
}
