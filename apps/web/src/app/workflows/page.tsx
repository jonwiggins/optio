"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { formatRelativeTime } from "@/lib/utils";
import { toast } from "sonner";
import { Loader2, Plus, Workflow, Play, Pause, Trash2 } from "lucide-react";

interface WorkflowWithStats {
  id: string;
  name: string;
  description: string | null;
  agentRuntime: string;
  model: string | null;
  enabled: boolean;
  maxConcurrent: number;
  maxRetries: number;
  createdAt: string;
  runCount: number;
  lastRunAt: string | null;
  totalCostUsd: string;
}

export default function WorkflowsPage() {
  usePageTitle("Workflows");
  const [workflows, setWorkflows] = useState<WorkflowWithStats[]>([]);
  const [loading, setLoading] = useState(true);

  const loadWorkflows = useCallback(() => {
    api
      .listWorkflows()
      .then((res) => setWorkflows(res.workflows as WorkflowWithStats[]))
      .catch(() => toast.error("Failed to load workflows"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadWorkflows();
  }, [loadWorkflows]);

  const handleToggle = async (wf: WorkflowWithStats) => {
    try {
      await api.updateWorkflow(wf.id, { enabled: !wf.enabled });
      toast.success(wf.enabled ? "Workflow disabled" : "Workflow enabled");
      loadWorkflows();
    } catch {
      toast.error("Failed to update workflow");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteWorkflow(id);
      toast.success("Workflow deleted");
      loadWorkflows();
    } catch {
      toast.error("Failed to delete workflow");
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
        <Link
          href="/workflows/new"
          className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Workflow
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading...
        </div>
      ) : workflows.length === 0 ? (
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <Workflow className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No workflows configured</p>
          <p className="text-xs mt-1">
            Create a workflow to define reusable multi-step agent pipelines.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {workflows.map((wf) => (
            <Link
              key={wf.id}
              href={`/workflows/${wf.id}`}
              className="block rounded-xl border border-border/50 bg-bg-card card-hover overflow-hidden"
            >
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`w-2 h-2 rounded-full shrink-0 ${wf.enabled ? "bg-green-500" : "bg-zinc-400"}`}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{wf.name}</span>
                      <span className="text-[11px] text-text-muted bg-bg-hover px-1.5 py-0.5 rounded">
                        {wf.agentRuntime}
                      </span>
                      {wf.model && (
                        <span className="text-[11px] text-text-muted bg-bg-hover px-1.5 py-0.5 rounded">
                          {wf.model}
                        </span>
                      )}
                    </div>
                    {wf.description && (
                      <p className="text-xs text-text-muted truncate mt-0.5">{wf.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
                      <span>
                        {wf.runCount} run{wf.runCount !== 1 ? "s" : ""}
                      </span>
                      {wf.lastRunAt && <span>Last: {formatRelativeTime(wf.lastRunAt)}</span>}
                      {parseFloat(wf.totalCostUsd) > 0 && (
                        <span>${parseFloat(wf.totalCostUsd).toFixed(2)}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div
                  className="flex items-center gap-1 shrink-0"
                  onClick={(e) => e.preventDefault()}
                >
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      handleToggle(wf);
                    }}
                    className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
                    title={wf.enabled ? "Disable" : "Enable"}
                  >
                    {wf.enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      handleDelete(wf.id);
                    }}
                    className="p-1.5 rounded-md hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
