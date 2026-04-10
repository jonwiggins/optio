"use client";

import Link from "next/link";
import { use, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { cn, formatRelativeTime, formatDuration } from "@/lib/utils";
import { toast } from "sonner";
import {
  Loader2,
  ArrowLeft,
  Play,
  Pause,
  Trash2,
  RefreshCw,
  Settings,
  Activity,
  Clock,
  DollarSign,
  Hash,
  Zap,
  Webhook,
  Calendar,
  CheckCircle2,
  XCircle,
  CircleDot,
  Timer,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface WorkflowDetail {
  id: string;
  name: string;
  description: string | null;
  promptTemplate: string;
  agentRuntime: string;
  model: string | null;
  maxTurns: number | null;
  budgetUsd: string | null;
  maxConcurrent: number;
  maxRetries: number;
  warmPoolSize: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt: string | null;
  totalCostUsd: string;
}

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

interface WorkflowTrigger {
  id: string;
  workflowId: string;
  type: string;
  config: Record<string, unknown> | null;
  paramMapping: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium tracking-wide uppercase transition-all duration-200",
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

// ── Trigger type icon ──────────────────────────────────────────────────────────

function TriggerTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "manual":
      return <Play className="w-3.5 h-3.5" />;
    case "schedule":
      return <Calendar className="w-3.5 h-3.5" />;
    case "webhook":
      return <Webhook className="w-3.5 h-3.5" />;
    default:
      return <Zap className="w-3.5 h-3.5" />;
  }
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function WorkflowDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [activeTab, setActiveTab] = useState<"runs" | "triggers" | "config">("runs");

  usePageTitle(workflow?.name ?? "Workflow");

  const refresh = useCallback(async () => {
    try {
      const [wfRes, runsRes, triggersRes] = await Promise.all([
        api.getWorkflow(id),
        api.getWorkflowRuns(id),
        api.getWorkflowTriggers(id),
      ]);
      setWorkflow(wfRes.workflow as WorkflowDetail);
      setRuns(runsRes.runs as WorkflowRun[]);
      setTriggers(triggersRes.triggers as WorkflowTrigger[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh while any runs are active
  useEffect(() => {
    const hasActiveRuns = runs.some((r) => r.state === "queued" || r.state === "running");
    if (!hasActiveRuns) return;
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [runs, refresh]);

  const handleToggleEnabled = async () => {
    if (!workflow) return;
    setActionLoading(true);
    try {
      await api.updateWorkflow(id, { enabled: !workflow.enabled });
      toast.success(workflow.enabled ? "Workflow disabled" : "Workflow enabled");
      await refresh();
    } catch {
      toast.error("Failed to update workflow");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await api.deleteWorkflow(id);
      toast.success("Workflow deleted");
      router.push("/workflows");
    } catch {
      toast.error("Failed to delete workflow");
    } finally {
      setActionLoading(false);
    }
  };

  // ── Loading / Error states ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading workflow...
      </div>
    );
  }

  if (error || !workflow) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link
          href="/workflows"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Workflows
        </Link>
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <XCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>{error ?? "Workflow not found"}</p>
        </div>
      </div>
    );
  }

  // ── Computed stats ─────────────────────────────────────────────────────────

  const completedRuns = runs.filter((r) => r.state === "completed").length;
  const failedRuns = runs.filter((r) => r.state === "failed").length;
  const activeRuns = runs.filter((r) => r.state === "running" || r.state === "queued").length;
  const successRate = runs.length > 0 ? Math.round((completedRuns / runs.length) * 100) : 0;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <Link
        href="/workflows"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Workflows
      </Link>

      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "w-2.5 h-2.5 rounded-full shrink-0",
              workflow.enabled ? "bg-green-500" : "bg-zinc-400",
            )}
          />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{workflow.name}</h1>
            {workflow.description && (
              <p className="text-sm text-text-muted mt-0.5">{workflow.description}</p>
            )}
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
          <button
            onClick={handleToggleEnabled}
            disabled={actionLoading}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors",
              workflow.enabled
                ? "hover:bg-warning/10 text-text-muted hover:text-warning"
                : "hover:bg-success/10 text-text-muted hover:text-success",
            )}
          >
            {workflow.enabled ? (
              <>
                <Pause className="w-4 h-4" /> Disable
              </>
            ) : (
              <>
                <Play className="w-4 h-4" /> Enable
              </>
            )}
          </button>
          <button
            onClick={handleDelete}
            disabled={actionLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-text-muted hover:text-error hover:bg-error/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="rounded-lg border border-border/50 bg-bg-card p-3">
          <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
            <Hash className="w-3.5 h-3.5" />
            Total Runs
          </div>
          <div className="text-lg font-semibold">{workflow.runCount}</div>
        </div>
        <div className="rounded-lg border border-border/50 bg-bg-card p-3">
          <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
            <Activity className="w-3.5 h-3.5" />
            Success Rate
          </div>
          <div className="text-lg font-semibold">
            {runs.length > 0 ? `${successRate}%` : "\u2014"}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 bg-bg-card p-3">
          <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
            <DollarSign className="w-3.5 h-3.5" />
            Total Cost
          </div>
          <div className="text-lg font-semibold">
            ${parseFloat(workflow.totalCostUsd).toFixed(2)}
          </div>
        </div>
        <div className="rounded-lg border border-border/50 bg-bg-card p-3">
          <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
            <Clock className="w-3.5 h-3.5" />
            Last Run
          </div>
          <div className="text-lg font-semibold">
            {workflow.lastRunAt ? formatRelativeTime(workflow.lastRunAt) : "\u2014"}
          </div>
        </div>
      </div>

      {/* Active runs indicator */}
      {activeRuns > 0 && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-sm text-primary">
          <Loader2 className="w-4 h-4 animate-spin" />
          {activeRuns} run{activeRuns !== 1 ? "s" : ""} active — auto-refreshing
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-border">
        {(["runs", "triggers", "config"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              activeTab === tab
                ? "border-primary text-text"
                : "border-transparent text-text-muted hover:text-text",
            )}
          >
            {tab === "runs" && `Runs (${runs.length})`}
            {tab === "triggers" && `Triggers (${triggers.length})`}
            {tab === "config" && "Configuration"}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "runs" && <RunsTable runs={runs} />}
      {activeTab === "triggers" && <TriggersList triggers={triggers} />}
      {activeTab === "config" && (
        <ConfigPanel workflow={workflow} showPrompt={showPrompt} setShowPrompt={setShowPrompt} />
      )}
    </div>
  );
}

// ── Runs table ─────────────────────────────────────────────────────────────────

function RunsTable({ runs }: { runs: WorkflowRun[] }) {
  if (runs.length === 0) {
    return (
      <div className="text-center py-8 text-text-muted border border-dashed border-border rounded-lg">
        <CircleDot className="w-6 h-6 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No runs yet</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/50 bg-bg-card">
            <th className="text-left px-4 py-2 text-xs font-medium text-text-muted">State</th>
            <th className="text-left px-4 py-2 text-xs font-medium text-text-muted">Started</th>
            <th className="text-left px-4 py-2 text-xs font-medium text-text-muted">Duration</th>
            <th className="text-left px-4 py-2 text-xs font-medium text-text-muted">Model</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-text-muted">Cost</th>
            <th className="text-right px-4 py-2 text-xs font-medium text-text-muted">Tokens</th>
            <th className="text-left px-4 py-2 text-xs font-medium text-text-muted">Error</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr
              key={run.id}
              className="border-b border-border/30 last:border-0 hover:bg-bg-hover/40"
            >
              <td className="px-4 py-2.5">
                <RunStateBadge state={run.state} />
              </td>
              <td className="px-4 py-2.5 text-text-muted text-xs">
                {run.startedAt
                  ? formatRelativeTime(run.startedAt)
                  : formatRelativeTime(run.createdAt)}
              </td>
              <td className="px-4 py-2.5 text-text-muted text-xs">
                {run.startedAt
                  ? formatDuration(run.startedAt, run.finishedAt ?? undefined)
                  : "\u2014"}
              </td>
              <td className="px-4 py-2.5 text-text-muted text-xs">{run.modelUsed ?? "\u2014"}</td>
              <td className="px-4 py-2.5 text-right text-xs">
                {run.costUsd ? `$${parseFloat(run.costUsd).toFixed(2)}` : "\u2014"}
              </td>
              <td className="px-4 py-2.5 text-right text-text-muted text-xs">
                {run.inputTokens != null && run.outputTokens != null
                  ? `${(run.inputTokens / 1000).toFixed(1)}k / ${(run.outputTokens / 1000).toFixed(1)}k`
                  : "\u2014"}
              </td>
              <td className="px-4 py-2.5 text-xs">
                {run.errorMessage ? (
                  <span
                    className="text-error truncate max-w-[200px] block"
                    title={run.errorMessage}
                  >
                    {run.errorMessage.length > 60
                      ? run.errorMessage.slice(0, 60) + "\u2026"
                      : run.errorMessage}
                  </span>
                ) : (
                  "\u2014"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Triggers list ──────────────────────────────────────────────────────────────

function TriggersList({ triggers }: { triggers: WorkflowTrigger[] }) {
  if (triggers.length === 0) {
    return (
      <div className="text-center py-8 text-text-muted border border-dashed border-border rounded-lg">
        <Zap className="w-6 h-6 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No triggers configured</p>
        <p className="text-xs mt-1">
          Triggers define how this workflow is started (manually, on schedule, or via webhook).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {triggers.map((trigger) => (
        <div
          key={trigger.id}
          className="rounded-lg border border-border/50 bg-bg-card p-4 flex items-center justify-between"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={cn(
                "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                trigger.enabled ? "bg-primary/10 text-primary" : "bg-bg-hover text-text-muted",
              )}
            >
              <TriggerTypeIcon type={trigger.type} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium capitalize">{trigger.type}</span>
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded uppercase font-medium",
                    trigger.enabled ? "text-success bg-success/10" : "text-text-muted bg-bg-hover",
                  )}
                >
                  {trigger.enabled ? "Active" : "Disabled"}
                </span>
              </div>
              {trigger.config && Object.keys(trigger.config).length > 0 && (
                <p className="text-xs text-text-muted mt-0.5 font-mono truncate">
                  {JSON.stringify(trigger.config)}
                </p>
              )}
              <p className="text-xs text-text-muted mt-0.5">
                Created {formatRelativeTime(trigger.createdAt)}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Config panel ───────────────────────────────────────────────────────────────

function ConfigPanel({
  workflow,
  showPrompt,
  setShowPrompt,
}: {
  workflow: WorkflowDetail;
  showPrompt: boolean;
  setShowPrompt: (v: boolean) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/50 bg-bg-card p-4">
        <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
          <Settings className="w-4 h-4 text-text-muted" />
          Workflow Configuration
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-text-muted text-xs block mb-0.5">Agent Runtime</span>
            <span className="font-medium">{workflow.agentRuntime}</span>
          </div>
          <div>
            <span className="text-text-muted text-xs block mb-0.5">Model</span>
            <span className="font-medium">{workflow.model ?? "Default"}</span>
          </div>
          <div>
            <span className="text-text-muted text-xs block mb-0.5">Max Turns</span>
            <span className="font-medium">{workflow.maxTurns ?? "Default"}</span>
          </div>
          <div>
            <span className="text-text-muted text-xs block mb-0.5">Budget</span>
            <span className="font-medium">
              {workflow.budgetUsd ? `$${workflow.budgetUsd}` : "Unlimited"}
            </span>
          </div>
          <div>
            <span className="text-text-muted text-xs block mb-0.5">Max Concurrent</span>
            <span className="font-medium">{workflow.maxConcurrent}</span>
          </div>
          <div>
            <span className="text-text-muted text-xs block mb-0.5">Max Retries</span>
            <span className="font-medium">{workflow.maxRetries}</span>
          </div>
          <div>
            <span className="text-text-muted text-xs block mb-0.5">Warm Pool</span>
            <span className="font-medium">{workflow.warmPoolSize}</span>
          </div>
          <div>
            <span className="text-text-muted text-xs block mb-0.5">Created</span>
            <span className="font-medium">{formatRelativeTime(workflow.createdAt)}</span>
          </div>
          <div>
            <span className="text-text-muted text-xs block mb-0.5">Updated</span>
            <span className="font-medium">{formatRelativeTime(workflow.updatedAt)}</span>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border/50 bg-bg-card p-4">
        <button
          onClick={() => setShowPrompt(!showPrompt)}
          className="text-sm font-medium flex items-center gap-2 w-full text-left"
        >
          <span className="flex-1">Prompt Template</span>
          <span className="text-xs text-text-muted">{showPrompt ? "Hide" : "Show"}</span>
        </button>
        {showPrompt && (
          <pre className="mt-3 text-xs text-text-muted bg-bg rounded-md p-3 overflow-x-auto whitespace-pre-wrap border border-border/30">
            {workflow.promptTemplate}
          </pre>
        )}
      </div>
    </div>
  );
}
