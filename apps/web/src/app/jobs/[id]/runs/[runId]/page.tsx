"use client";

import Link from "next/link";
import { use, useState, useEffect, useCallback } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { useWorkflowRunLogs } from "@/hooks/use-workflow-run-logs";
import { LogViewer } from "@/components/log-viewer";
import { TokenRefreshBanner } from "@/components/token-refresh-banner";
import { DetailHeader } from "@/components/detail-header";
import { PrStatusBar } from "@/components/pr-status-bar";
import { WorkflowRunPipelineTimeline } from "@/components/workflow-run-pipeline-timeline";
import { ErrorBoundary } from "@/components/error-boundary";
import { api } from "@/lib/api-client";
import { classifyError } from "@optio/shared";
import { cn, formatRelativeTime, formatDuration } from "@/lib/utils";
import { toast } from "sonner";
import {
  Loader2,
  ArrowLeft,
  RefreshCw,
  XCircle,
  RotateCcw,
  StopCircle,
  Clock,
  Bot,
  Hash,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Braces,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface WorkflowRun {
  id: string;
  workflowId: string;
  triggerId: string | null;
  params: Record<string, unknown> | null;
  state: string;
  output: Record<string, unknown> | null;
  costUsd: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  modelUsed: string | null;
  errorMessage: string | null;
  sessionId: string | null;
  podName: string | null;
  retryCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowSummary {
  id: string;
  name: string;
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function WorkflowRunDetailPage({
  params,
}: {
  params: Promise<{ id: string; runId: string }>;
}) {
  const { id: workflowId, runId } = use(params);

  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [showTimeline, setShowTimeline] = useState(true);
  const [outputCollapsed, setOutputCollapsed] = useState(false);
  const [paramsCollapsed, setParamsCollapsed] = useState(false);

  usePageTitle(run ? `Run ${run.id.slice(0, 8)}` : "Task Run");

  const isActive = run?.state === "running" || run?.state === "queued";

  const refresh = useCallback(async () => {
    try {
      const [runRes, wfRes] = await Promise.all([
        api.getWorkflowRun(runId),
        api.getWorkflow(workflowId),
      ]);
      setRun(runRes.run as WorkflowRun);
      setWorkflow({ id: wfRes.workflow.id, name: wfRes.workflow.name });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load job run");
    } finally {
      setLoading(false);
    }
  }, [runId, workflowId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [isActive, refresh]);

  // Live log streaming via WebSocket — same hook contract as task/review pages.
  const externalLogs = useWorkflowRunLogs(runId, isActive ?? false);

  const handleRetry = async () => {
    setActionLoading(true);
    try {
      const res = await api.retryWorkflowRun(runId);
      setRun(res.run as WorkflowRun);
      toast.success("Run retried");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to retry run");
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    setActionLoading(true);
    try {
      const res = await api.cancelWorkflowRun(runId);
      setRun(res.run as WorkflowRun);
      toast.success("Run cancelled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel run");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading run...
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link
          href={`/jobs/${workflowId}`}
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <XCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>{error ?? "Task run not found"}</p>
        </div>
      </div>
    );
  }

  const classifiedError = run.errorMessage ? classifyError(run.errorMessage) : null;
  const duration = run.startedAt
    ? formatDuration(run.startedAt, run.finishedAt ?? undefined)
    : null;
  const canRetry = run.state === "failed";
  const canCancel = run.state === "running" || run.state === "queued";
  const hasOutput = run.output && Object.keys(run.output).length > 0;
  const hasParams = run.params && Object.keys(run.params).length > 0;

  return (
    <div className="flex flex-col h-full">
      <DetailHeader
        title={`Run ${run.id.slice(0, 8)}`}
        subtitle={
          <Link
            href={`/jobs/${workflowId}`}
            className="inline-flex items-center gap-1 hover:text-primary"
          >
            <ArrowLeft className="w-3 h-3" />
            {workflow?.name ?? "Job"}
          </Link>
        }
        state={run.state}
        metaItems={
          [
            run.modelUsed ? (
              <>
                <Bot className="w-3 h-3" />
                {run.modelUsed}
              </>
            ) : null,
            duration ? (
              <>
                <Clock className="w-3 h-3" />
                {duration}
              </>
            ) : (
              <>
                <Clock className="w-3 h-3" />
                {formatRelativeTime(run.createdAt)}
              </>
            ),
            run.retryCount > 0 ? (
              <>
                <RotateCcw className="w-3 h-3" />
                retry {run.retryCount}
              </>
            ) : null,
          ].filter(Boolean) as React.ReactNode[]
        }
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
            {canCancel && (
              <button
                onClick={handleCancel}
                disabled={actionLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 transition-colors disabled:opacity-50"
              >
                <StopCircle className="w-3 h-3" />
                Cancel
              </button>
            )}
          </>
        }
      />

      {/* Status bar — hosts the Timeline toggle on the right and surfaces
          glanceable run economics (cost, tokens) on the left when present. */}
      <div className="shrink-0 border-b border-border bg-bg-card px-4 py-2">
        <div className="max-w-5xl mx-auto">
          <PrStatusBar
            actions={
              <>
                {run.costUsd && (
                  <span className="text-text-muted">
                    Cost: ${parseFloat(run.costUsd).toFixed(4)}
                  </span>
                )}
                {run.inputTokens != null && run.outputTokens != null && (
                  <span className="text-text-muted">
                    {(run.inputTokens / 1000).toFixed(1)}k / {(run.outputTokens / 1000).toFixed(1)}k
                  </span>
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
        </div>
      </div>

      {/* Auth banner — same recovery surface as task/review pages */}
      {classifiedError?.category === "auth" && (
        <div className="shrink-0 border-b border-border bg-bg-card">
          <div className="max-w-5xl mx-auto px-4 py-3">
            <TokenRefreshBanner onSaved={refresh} />
          </div>
        </div>
      )}

      {/* Classified error banner — matches /tasks/[id] and /reviews/[id] */}
      {classifiedError && classifiedError.category !== "auth" && (
        <div className="shrink-0 border-b border-error/20 bg-error/5">
          <div className="max-w-5xl mx-auto px-4 py-3">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-error shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <h3 className="text-sm font-medium text-error">{classifiedError.title}</h3>
                  <p className="text-xs text-error/70 mt-0.5">{classifiedError.description}</p>
                </div>
                {classifiedError.remedy && (
                  <div className="p-2.5 rounded-md bg-bg/50 border border-border">
                    <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                      Suggested fix
                    </div>
                    <pre className="text-xs text-text/80 whitespace-pre-wrap font-mono">
                      {classifiedError.remedy}
                    </pre>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  {classifiedError.retryable && canRetry && (
                    <button
                      onClick={handleRetry}
                      disabled={actionLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50 btn-press transition-all"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Retry
                    </button>
                  )}
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-error/10 text-error">
                    {classifiedError.category}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main content: log column + timeline sidebar — mirrors /tasks/[id] */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Output + Params widgets — side-by-side when both present so the
              params row stays glanceable next to the run's structured output.
              Each is independently collapsible. */}
          {(hasOutput || hasParams) && (
            <div className="shrink-0 border-b border-border bg-bg-card grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
              {hasParams && (
                <div className="min-w-0">
                  <button
                    onClick={() => setParamsCollapsed((v) => !v)}
                    className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-bg-hover transition-colors"
                  >
                    {paramsCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5 text-text-muted shrink-0" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-text-muted shrink-0" />
                    )}
                    <Hash className="w-3.5 h-3.5 text-text-muted shrink-0" />
                    <span className="font-medium text-text-muted">Parameters</span>
                    <span className="text-[10px] text-text-muted/70">
                      {Object.keys(run.params ?? {}).length}
                    </span>
                  </button>
                  {!paramsCollapsed && (
                    <div className="px-4 pb-3 space-y-1.5 max-h-[40vh] overflow-y-auto">
                      {Object.entries(run.params ?? {}).map(([key, value]) => (
                        <div key={key} className="flex items-start gap-3 text-xs">
                          <span className="text-text-muted font-mono shrink-0 pt-0.5 min-w-[100px]">
                            {key}
                          </span>
                          <span className="text-text font-mono break-all">
                            {typeof value === "string" ? value : JSON.stringify(value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {hasOutput && (
                <div className="min-w-0">
                  <button
                    onClick={() => setOutputCollapsed((v) => !v)}
                    className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-bg-hover transition-colors"
                  >
                    {outputCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5 text-text-muted shrink-0" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-text-muted shrink-0" />
                    )}
                    <Braces className="w-3.5 h-3.5 text-text-muted shrink-0" />
                    <span className="font-medium text-text-muted">Output</span>
                    <span className="text-[10px] text-text-muted/70">
                      {Object.keys(run.output ?? {}).length}{" "}
                      {Object.keys(run.output ?? {}).length === 1 ? "field" : "fields"}
                    </span>
                  </button>
                  {!outputCollapsed && (
                    <div className="px-4 pb-3 max-h-[40vh] overflow-y-auto">
                      <pre className="text-xs text-text/80 bg-bg rounded-md p-3 overflow-x-auto whitespace-pre-wrap border border-border/30 font-mono">
                        {JSON.stringify(run.output, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Logs */}
          <div className="flex-1 overflow-hidden">
            <ErrorBoundary label="Workflow run log viewer">
              <LogViewer externalLogs={externalLogs} />
            </ErrorBoundary>
          </div>
        </div>

        {/* Timeline sidebar — mirrors /tasks/[id] and /reviews/[id] */}
        {showTimeline && (
          <div className="hidden md:flex w-80 shrink-0 border-l border-border overflow-auto bg-bg-card flex-col">
            <div className="flex items-center gap-1 p-2 border-b border-border">
              <span className="px-2.5 py-1 rounded text-xs bg-primary/10 text-primary font-medium">
                Pipeline
              </span>
            </div>
            <div className="flex-1 overflow-auto p-3">
              <ErrorBoundary label="Workflow run pipeline timeline">
                <WorkflowRunPipelineTimeline run={run} />
              </ErrorBoundary>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
