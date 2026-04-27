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
  XCircle,
  CircleDot,
  Pencil,
  Copy,
  CopyPlus,
} from "lucide-react";
import { RunWorkflowDialog } from "@/components/run-workflow-dialog";
import { StateBadge } from "@/components/state-badge";
import { DetailHeader } from "@/components/detail-header";
import { MetadataCard } from "@/components/metadata-card";

// ── Types ──────────────────────────────────────────────────────────────────────

interface WorkflowDetail {
  id: string;
  name: string;
  description: string | null;
  promptTemplate: string;
  paramsSchema: Record<string, unknown> | null;
  agentRuntime: string;
  model: string | null;
  maxTurns: number | null;
  budgetUsd: string | null;
  maxConcurrent: number;
  maxRetries: number;
  warmPoolSize: number;
  maxPodInstances: number;
  maxAgentsPerPod: number;
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
  const [showRunDialog, setShowRunDialog] = useState(false);

  usePageTitle(workflow?.name ?? "Task");

  const refresh = useCallback(async () => {
    try {
      const [wfRes, runsRes, triggersRes] = await Promise.all([
        api.getWorkflow(id),
        api.listWorkflowRuns(id),
        api.listWorkflowTriggers(id),
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
      toast.success(workflow.enabled ? "Task disabled" : "Task enabled");
      await refresh();
    } catch {
      toast.error("Failed to update job");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDuplicate = async () => {
    setActionLoading(true);
    try {
      const res = await api.cloneWorkflow(id);
      toast.success("Task duplicated");
      router.push(`/jobs/${res.workflow.id}/edit`);
    } catch {
      toast.error("Failed to duplicate job");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this job and all its runs? This cannot be undone.")) return;
    setActionLoading(true);
    try {
      await api.deleteWorkflow(id);
      toast.success("Task deleted");
      router.push("/jobs");
    } catch {
      toast.error("Failed to delete job");
    } finally {
      setActionLoading(false);
    }
  };

  // ── Loading / Error states ─────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading job...
      </div>
    );
  }

  if (error || !workflow) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link
          href="/jobs"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Jobs
        </Link>
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <XCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>{error ?? "Task not found"}</p>
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
    <>
      <DetailHeader
        title={workflow.name}
        subtitle={
          <Link href="/jobs" className="inline-flex items-center gap-1 hover:text-primary">
            <ArrowLeft className="w-3 h-3" />
            Jobs
          </Link>
        }
        state={workflow.enabled ? "enabled" : "disabled"}
        metaItems={
          workflow.description
            ? [<span className="text-text-muted">{workflow.description}</span>]
            : undefined
        }
        rightSlot={
          <button
            onClick={() => refresh()}
            disabled={actionLoading}
            className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        }
        actions={
          <>
            <button
              onClick={() => setShowRunDialog(true)}
              disabled={!workflow.enabled || actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={workflow.enabled ? "Run this task" : "Task is disabled"}
            >
              <Play className="w-3 h-3" /> Run
            </button>
            <Link
              href={`/jobs/${id}/edit`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg text-text-muted text-xs hover:bg-bg-hover hover:text-text transition-colors"
            >
              <Pencil className="w-3 h-3" /> Edit
            </Link>
            <button
              onClick={handleDuplicate}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg text-text-muted text-xs hover:bg-bg-hover hover:text-text transition-colors"
              title="Duplicate workflow"
            >
              <CopyPlus className="w-3 h-3" /> Duplicate
            </button>
            <button
              onClick={handleToggleEnabled}
              disabled={actionLoading}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors",
                workflow.enabled
                  ? "bg-warning/10 text-warning hover:bg-warning/20"
                  : "bg-success/10 text-success hover:bg-success/20",
              )}
            >
              {workflow.enabled ? (
                <>
                  <Pause className="w-3 h-3" /> Disable
                </>
              ) : (
                <>
                  <Play className="w-3 h-3" /> Enable
                </>
              )}
            </button>
            <button
              onClick={handleDelete}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 transition-colors"
            >
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          </>
        }
      />

      <div className="p-6 max-w-5xl mx-auto">
        {/* Stats bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <MetadataCard icon={Hash} label="Total Runs" value={workflow.runCount} size="lg" />
          <MetadataCard
            icon={Activity}
            label="Success Rate"
            value={runs.length > 0 ? `${successRate}%` : "\u2014"}
            size="lg"
          />
          <MetadataCard
            icon={DollarSign}
            label="Total Cost"
            value={`$${parseFloat(workflow.totalCostUsd).toFixed(2)}`}
            size="lg"
          />
          <MetadataCard
            icon={Clock}
            label="Last Run"
            value={workflow.lastRunAt ? formatRelativeTime(workflow.lastRunAt) : "\u2014"}
            size="lg"
          />
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
        {activeTab === "runs" && (
          <RunsTable
            runs={runs}
            workflowId={id}
            onRunClick={() => workflow.enabled && setShowRunDialog(true)}
            canRun={workflow.enabled}
          />
        )}
        {activeTab === "triggers" && <TriggersList triggers={triggers} workflowId={id} />}
        {activeTab === "config" && (
          <ConfigPanel workflow={workflow} showPrompt={showPrompt} setShowPrompt={setShowPrompt} />
        )}

        {/* Run dialog */}
        {showRunDialog && (
          <RunWorkflowDialog
            workflowId={workflow.id}
            workflowName={workflow.name}
            paramsSchema={workflow.paramsSchema}
            onClose={() => setShowRunDialog(false)}
            onRun={refresh}
          />
        )}
      </div>
    </>
  );
}

// ── Runs table ─────────────────────────────────────────────────────────────────

const RUN_FILTERS = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
] as const;

type RunFilter = (typeof RUN_FILTERS)[number]["value"];

function RunsTable({
  runs,
  workflowId,
  onRunClick,
  canRun,
}: {
  runs: WorkflowRun[];
  workflowId: string;
  onRunClick: () => void;
  canRun: boolean;
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<RunFilter>("all");
  const filteredRuns =
    filter === "all"
      ? runs
      : runs.filter((r) =>
          filter === "running" ? r.state === "running" || r.state === "queued" : r.state === filter,
        );

  if (runs.length === 0) {
    return (
      <div className="text-center py-8 text-text-muted border border-dashed border-border rounded-lg">
        <CircleDot className="w-6 h-6 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No runs yet</p>
        <p className="text-xs mt-1 mb-3">Start your first run to see results here.</p>
        <button
          onClick={onRunClick}
          disabled={!canRun}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play className="w-3 h-3" /> Run Now
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        {RUN_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "text-xs px-2.5 py-1 rounded-md font-medium transition-colors",
              filter === f.value
                ? "bg-primary/10 text-primary"
                : "text-text-muted hover:text-text hover:bg-bg-hover",
            )}
          >
            {f.label}
            {f.value !== "all" && (
              <span className="ml-1 text-[10px] opacity-70">
                {f.value === "running"
                  ? runs.filter((r) => r.state === "running" || r.state === "queued").length
                  : runs.filter((r) => r.state === f.value).length}
              </span>
            )}
          </button>
        ))}
      </div>
      {filteredRuns.length === 0 ? (
        <div className="text-center py-6 text-text-muted border border-dashed border-border rounded-lg">
          <p className="text-sm">No {filter} runs</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 bg-bg-card">
                <th className="text-left px-4 py-2 text-xs font-medium text-text-muted">State</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-text-muted">Started</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-text-muted">
                  Duration
                </th>
                <th className="text-left px-4 py-2 text-xs font-medium text-text-muted">Model</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-text-muted">Cost</th>
                <th className="text-right px-4 py-2 text-xs font-medium text-text-muted">Tokens</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-text-muted">Error</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuns.map((run) => (
                <tr
                  key={run.id}
                  className="border-b border-border/30 last:border-0 hover:bg-bg-hover/40 cursor-pointer"
                  onClick={() => router.push(`/jobs/${workflowId}/runs/${run.id}`)}
                >
                  <td className="px-4 py-2.5">
                    <Link href={`/jobs/${workflowId}/runs/${run.id}`}>
                      <StateBadge state={run.state} />
                    </Link>
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
                  <td className="px-4 py-2.5 text-text-muted text-xs">
                    {run.modelUsed ?? "\u2014"}
                  </td>
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
      )}
    </div>
  );
}

// ── Triggers list ──────────────────────────────────────────────────────────────

function TriggersList({
  triggers,
  workflowId,
}: {
  triggers: WorkflowTrigger[];
  workflowId: string;
}) {
  if (triggers.length === 0) {
    return (
      <div className="text-center py-8 text-text-muted border border-dashed border-border rounded-lg">
        <Zap className="w-6 h-6 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No triggers configured</p>
        <p className="text-xs mt-1 mb-3">
          Triggers define how this job is started (manually, on schedule, or via webhook).
        </p>
        <Link
          href={`/jobs/${workflowId}/edit`}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg-hover text-text-muted text-xs font-medium hover:text-text transition-colors"
        >
          <Pencil className="w-3 h-3" /> Configure Triggers
        </Link>
      </div>
    );
  }

  const copyWebhookUrl = (path: string) => {
    const url = `${window.location.origin}/api/hooks/${path}`;
    navigator.clipboard.writeText(url);
    toast.success("Webhook URL copied");
  };

  return (
    <div className="space-y-3">
      {triggers.map((trigger) => {
        const rawPath =
          trigger.type === "webhook"
            ? (trigger.config as Record<string, unknown> | null)?.path
            : null;
        const webhookPath = typeof rawPath === "string" ? rawPath : null;

        return (
          <div
            key={trigger.id}
            className="rounded-lg border border-border/50 bg-bg-card p-4 flex items-center justify-between"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div
                className={cn(
                  "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                  trigger.enabled ? "bg-primary/10 text-primary" : "bg-bg-hover text-text-muted",
                )}
              >
                <TriggerTypeIcon type={trigger.type} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium capitalize">{trigger.type}</span>
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded uppercase font-medium",
                      trigger.enabled
                        ? "text-success bg-success/10"
                        : "text-text-muted bg-bg-hover",
                    )}
                  >
                    {trigger.enabled ? "Active" : "Disabled"}
                  </span>
                </div>
                {webhookPath && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <code className="text-xs text-text-muted bg-bg rounded px-1.5 py-0.5 font-mono truncate">
                      {window.location.origin}/api/hooks/{webhookPath}
                    </code>
                    <button
                      onClick={() => copyWebhookUrl(webhookPath)}
                      className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text transition-colors shrink-0"
                      title="Copy webhook URL"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>
                )}
                {!webhookPath && trigger.config && Object.keys(trigger.config).length > 0 && (
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
        );
      })}
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
          Task Configuration
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
            <span className="text-text-muted text-xs block mb-0.5">Max Pod Instances</span>
            <span className="font-medium">{workflow.maxPodInstances ?? 1}</span>
          </div>
          <div>
            <span className="text-text-muted text-xs block mb-0.5">Max Agents Per Pod</span>
            <span className="font-medium">{workflow.maxAgentsPerPod ?? 2}</span>
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

      {workflow.paramsSchema && (
        <div className="rounded-lg border border-border/50 bg-bg-card p-4">
          <h3 className="text-sm font-medium mb-2">Parameter Schema</h3>
          <pre className="text-xs text-text-muted bg-bg rounded-md p-3 overflow-x-auto whitespace-pre-wrap border border-border/30 max-h-40">
            {JSON.stringify(workflow.paramsSchema, null, 2)}
          </pre>
        </div>
      )}

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
