"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { Skeleton } from "@/components/skeleton";
import { toast } from "sonner";
import { Workflow, Clock, Webhook, Hand, Play } from "lucide-react";
import { RunWorkflowDialog } from "@/components/run-workflow-dialog";

interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  agentRuntime: string;
  model: string | null;
  enabled: boolean;
  maxConcurrent: number;
  maxRetries: number;
  paramsSchema: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt: string | null;
  totalCostUsd: string | null;
  triggerTypes: string[];
}

const TRIGGER_ICONS: Record<string, { icon: typeof Clock; label: string }> = {
  manual: { icon: Hand, label: "Manual" },
  schedule: { icon: Clock, label: "Schedule" },
  webhook: { icon: Webhook, label: "Webhook" },
};

function formatDate(dateStr: string | null) {
  if (!dateStr) return "\u2014";
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

function formatCost(costStr: string | null) {
  if (!costStr) return "$0.00";
  const val = parseFloat(costStr);
  if (isNaN(val) || val === 0) return "$0.00";
  return `$${val.toFixed(2)}`;
}

function WorkflowTableSkeleton() {
  return (
    <div className="rounded-xl border border-border/50 bg-bg-card overflow-hidden">
      <div className="border-b border-border/50 px-4 py-3">
        <Skeleton className="h-4 w-32" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-3.5 border-b border-border/30 last:border-b-0"
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export default function WorkflowsPage() {
  usePageTitle("Workflows");
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [runTarget, setRunTarget] = useState<WorkflowSummary | null>(null);

  const loadWorkflows = useCallback(() => {
    api
      .listWorkflows()
      .then((res) => setWorkflows(res.workflows as WorkflowSummary[]))
      .catch(() => toast.error("Failed to load workflows"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
      </div>

      {loading ? (
        <WorkflowTableSkeleton />
      ) : workflows.length === 0 ? (
        <div className="text-center py-16 text-text-muted border border-dashed border-border rounded-lg">
          <Workflow className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No workflows yet</p>
          <p className="text-sm mt-1">
            Workflows let you define reusable agent pipelines with triggers, parameters, and
            budgets.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 bg-bg-card overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[2fr_80px_120px_60px_100px_80px_70px_40px] gap-2 px-4 py-2.5 border-b border-border/50 text-xs font-medium text-text-muted uppercase tracking-wider">
            <span>Name</span>
            <span>Status</span>
            <span>Runtime</span>
            <span className="text-right">Runs</span>
            <span>Last Run</span>
            <span className="text-right">Cost</span>
            <span>Triggers</span>
            <span></span>
          </div>

          {/* Table rows */}
          {workflows.map((wf) => (
            <Link
              key={wf.id}
              href={`/workflows/${wf.id}`}
              className="grid grid-cols-[2fr_80px_120px_60px_100px_80px_70px_40px] gap-2 items-center px-4 py-3 border-b border-border/30 last:border-b-0 hover:bg-bg-hover/50 transition-colors"
            >
              {/* Name */}
              <div className="min-w-0">
                <span className="text-sm font-medium truncate block">{wf.name}</span>
                {wf.description && (
                  <span className="text-xs text-text-muted truncate block mt-0.5">
                    {wf.description}
                  </span>
                )}
              </div>

              {/* Status */}
              <div>
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
                    wf.enabled ? "bg-success/10 text-success" : "bg-text-muted/10 text-text-muted"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      wf.enabled ? "bg-success" : "bg-text-muted/50"
                    }`}
                  />
                  {wf.enabled ? "Active" : "Off"}
                </span>
              </div>

              {/* Runtime */}
              <span className="text-xs text-text-muted truncate">
                {wf.agentRuntime}
                {wf.model ? ` / ${wf.model}` : ""}
              </span>

              {/* Runs */}
              <span className="text-sm text-right tabular-nums">{wf.runCount}</span>

              {/* Last Run */}
              <span className="text-xs text-text-muted">{formatDate(wf.lastRunAt)}</span>

              {/* Cost */}
              <span className="text-sm text-right tabular-nums">{formatCost(wf.totalCostUsd)}</span>

              {/* Trigger icons */}
              <div className="flex items-center gap-1">
                {wf.triggerTypes.map((type) => {
                  const info = TRIGGER_ICONS[type];
                  if (!info) return null;
                  const Icon = info.icon;
                  return (
                    <span key={type} title={info.label} className="text-text-muted hover:text-text">
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                  );
                })}
                {wf.triggerTypes.length === 0 && (
                  <span className="text-xs text-text-muted/50">&mdash;</span>
                )}
              </div>

              {/* Run action */}
              <div>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    setRunTarget(wf);
                  }}
                  disabled={!wf.enabled}
                  className="p-1.5 rounded-md hover:bg-primary/10 text-text-muted hover:text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title={wf.enabled ? "Run workflow" : "Workflow is disabled"}
                >
                  <Play className="w-4 h-4" />
                </button>
              </div>
            </Link>
          ))}
        </div>
      )}

      {runTarget && (
        <RunWorkflowDialog
          workflowId={runTarget.id}
          workflowName={runTarget.name}
          paramsSchema={runTarget.paramsSchema}
          onClose={() => setRunTarget(null)}
          onRun={loadWorkflows}
        />
      )}
    </div>
  );
}
