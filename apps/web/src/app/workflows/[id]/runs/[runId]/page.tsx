"use client";

import Link from "next/link";
import { use, useState, useEffect, useCallback } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { useWorkflowRunLogs } from "@/hooks/use-workflow-run-logs";
import { LogViewer } from "@/components/log-viewer";
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
  DollarSign,
  Hash,
  Bot,
  Server,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Timer,
  Braces,
  FileText,
  Activity,
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

// ── Run state badge ────────────────────────────────────────────────────────────

const RUN_STATE_CONFIG: Record<
  string,
  { label: string; color: string; dotColor: string; glowClass: string; pulse?: boolean }
> = {
  queued: {
    label: "Queued",
    color: "text-info",
    dotColor: "bg-info",
    glowClass: "badge-glow-info",
  },
  running: {
    label: "Running",
    color: "text-primary",
    dotColor: "bg-primary",
    glowClass: "badge-glow-primary",
    pulse: true,
  },
  completed: {
    label: "Completed",
    color: "text-success",
    dotColor: "bg-success",
    glowClass: "badge-glow-success",
  },
  failed: {
    label: "Failed",
    color: "text-error",
    dotColor: "bg-error",
    glowClass: "badge-glow-error",
  },
};

function RunStateBadge({ state }: { state: string }) {
  const config = RUN_STATE_CONFIG[state] ?? {
    label: state,
    color: "text-text-muted",
    dotColor: "bg-text-muted",
    glowClass: "badge-glow-muted",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium tracking-wide uppercase transition-all duration-200",
        config.color,
        config.glowClass,
      )}
    >
      <span
        className={cn("w-1.5 h-1.5 rounded-full", config.dotColor, config.pulse && "glow-dot")}
      />
      {config.label}
    </span>
  );
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
  const [activeTab, setActiveTab] = useState<"logs" | "output" | "params">("logs");
  const [showParams, setShowParams] = useState(true);

  usePageTitle(run ? `Run ${run.id.slice(0, 8)}` : "Workflow Run");

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
      setError(err instanceof Error ? err.message : "Failed to load workflow run");
    } finally {
      setLoading(false);
    }
  }, [runId, workflowId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh while active
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [isActive, refresh]);

  // Logs hook
  const logData = useWorkflowRunLogs(runId, isActive ?? false);

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

  // ── Loading / Error states ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading workflow run...
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link
          href={`/workflows/${workflowId}`}
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Workflow
        </Link>
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <XCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>{error ?? "Workflow run not found"}</p>
        </div>
      </div>
    );
  }

  // ── Computed values ─────────────────────────────────────────────────────────

  const classifiedError = run.errorMessage ? classifyError(run.errorMessage) : null;
  const duration = run.startedAt
    ? formatDuration(run.startedAt, run.finishedAt ?? undefined)
    : null;
  const canRetry = run.state === "failed";
  const canCancel = run.state === "running" || run.state === "queued";

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm text-text-muted mb-4">
        <Link href="/workflows" className="hover:text-text transition-colors">
          Workflows
        </Link>
        <span>/</span>
        <Link href={`/workflows/${workflowId}`} className="hover:text-text transition-colors">
          {workflow?.name ?? "Workflow"}
        </Link>
        <span>/</span>
        <span className="text-text">Run {run.id.slice(0, 8)}</span>
      </div>

      {/* Header */}
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <RunStateBadge state={run.state} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Run {run.id.slice(0, 8)}</h1>
            <p className="text-sm text-text-muted mt-0.5">
              Created {formatRelativeTime(run.createdAt)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => refresh()}
            disabled={actionLoading}
            className="p-2 rounded-md hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {canRetry && (
            <button
              onClick={handleRetry}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm hover:bg-primary/10 text-text-muted hover:text-primary transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              Retry
            </button>
          )}
          {canCancel && (
            <button
              onClick={handleCancel}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-text-muted hover:text-error hover:bg-error/10 transition-colors"
            >
              <StopCircle className="w-4 h-4" />
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Active indicator */}
      {isActive && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-sm text-primary">
          <Loader2 className="w-4 h-4 animate-spin" />
          Run is {run.state} — auto-refreshing
        </div>
      )}

      {/* Metadata bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <MetadataCard icon={Timer} label="Duration" value={duration ?? "\u2014"} />
        <MetadataCard
          icon={DollarSign}
          label="Cost"
          value={run.costUsd ? `$${parseFloat(run.costUsd).toFixed(2)}` : "\u2014"}
        />
        <MetadataCard icon={Bot} label="Model" value={run.modelUsed ?? "\u2014"} />
        <MetadataCard
          icon={Hash}
          label="Tokens"
          value={
            run.inputTokens != null && run.outputTokens != null
              ? `${(run.inputTokens / 1000).toFixed(1)}k / ${(run.outputTokens / 1000).toFixed(1)}k`
              : "\u2014"
          }
        />
      </div>

      {/* Secondary metadata */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <MetadataCard icon={Server} label="Pod" value={run.podName ?? "\u2014"} />
        <MetadataCard
          icon={Activity}
          label="Session"
          value={run.sessionId?.slice(0, 8) ?? "\u2014"}
        />
        <MetadataCard icon={RotateCcw} label="Retry Count" value={String(run.retryCount)} />
        <MetadataCard
          icon={Clock}
          label="Started"
          value={run.startedAt ? formatRelativeTime(run.startedAt) : "\u2014"}
        />
      </div>

      {/* Error panel */}
      {classifiedError && (
        <div className="mb-6 rounded-lg border border-error/30 bg-error/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-error shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-error">{classifiedError.title}</h3>
              <p className="text-sm text-text-muted mt-1">{classifiedError.description}</p>
              {classifiedError.remedy && (
                <div className="mt-2 text-xs text-text-muted bg-bg rounded-md p-2 font-mono whitespace-pre-wrap border border-border/30">
                  {classifiedError.remedy}
                </div>
              )}
              <div className="flex items-center gap-3 mt-2 text-xs text-text-muted">
                <span className="capitalize">{classifiedError.category}</span>
                {classifiedError.retryable && (
                  <span className="text-primary flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Retryable
                  </span>
                )}
              </div>
            </div>
          </div>
          {run.errorMessage && (
            <details className="mt-3">
              <summary className="text-xs text-text-muted cursor-pointer hover:text-text">
                Raw error message
              </summary>
              <pre className="mt-2 text-xs text-error/80 bg-bg rounded-md p-2 overflow-x-auto whitespace-pre-wrap border border-border/30">
                {run.errorMessage}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-border">
        {(
          [
            { key: "logs", label: "Logs", icon: FileText },
            { key: "output", label: "Output", icon: Braces },
            { key: "params", label: "Parameters", icon: Hash },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              activeTab === key
                ? "border-primary text-text"
                : "border-transparent text-text-muted hover:text-text",
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "logs" && (
        <div className="rounded-lg border border-border/50 overflow-hidden">
          <LogViewer
            externalLogs={{
              logs: logData.logs,
              connected: logData.connected,
              capped: logData.capped,
              clear: logData.clear,
            }}
          />
        </div>
      )}

      {activeTab === "output" && <OutputPanel output={run.output} />}

      {activeTab === "params" && (
        <ParamsPanel params={run.params} showParams={showParams} setShowParams={setShowParams} />
      )}
    </div>
  );
}

// ── Metadata card ───────────────────────────────────────────────────────────

function MetadataCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className="text-sm font-semibold truncate" title={value}>
        {value}
      </div>
    </div>
  );
}

// ── Output panel ────────────────────────────────────────────────────────────

function OutputPanel({ output }: { output: Record<string, unknown> | null }) {
  if (!output) {
    return (
      <div className="text-center py-8 text-text-muted border border-dashed border-border rounded-lg">
        <Braces className="w-6 h-6 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No output data</p>
        <p className="text-xs mt-1">Output will appear here when the run completes.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/50 bg-bg-card p-4">
      <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
        <Braces className="w-4 h-4 text-text-muted" />
        Run Output
      </h3>
      <pre className="text-xs text-text-muted bg-bg rounded-md p-3 overflow-x-auto whitespace-pre-wrap border border-border/30 max-h-[500px] overflow-y-auto">
        {JSON.stringify(output, null, 2)}
      </pre>
    </div>
  );
}

// ── Params panel ────────────────────────────────────────────────────────────

function ParamsPanel({
  params,
  showParams,
  setShowParams,
}: {
  params: Record<string, unknown> | null;
  showParams: boolean;
  setShowParams: (v: boolean) => void;
}) {
  if (!params || Object.keys(params).length === 0) {
    return (
      <div className="text-center py-8 text-text-muted border border-dashed border-border rounded-lg">
        <Hash className="w-6 h-6 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No parameters</p>
        <p className="text-xs mt-1">This run was started without any parameters.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/50 bg-bg-card p-4">
      <button
        onClick={() => setShowParams(!showParams)}
        className="text-sm font-medium flex items-center gap-2 w-full text-left"
      >
        {showParams ? (
          <ChevronDown className="w-4 h-4 text-text-muted" />
        ) : (
          <ChevronRight className="w-4 h-4 text-text-muted" />
        )}
        <span className="flex-1">Run Parameters</span>
        <span className="text-xs text-text-muted">{Object.keys(params).length} params</span>
      </button>
      {showParams && (
        <div className="mt-3 space-y-2">
          {Object.entries(params).map(([key, value]) => (
            <div key={key} className="flex items-start gap-3 text-sm">
              <span className="text-text-muted font-mono text-xs shrink-0 pt-0.5">{key}</span>
              <span className="text-text font-mono text-xs break-all">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
