"use client";

import { useState } from "react";
import { Play, X, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { WorkflowParamsForm } from "./workflow-params-form";

interface RunWorkflowDialogProps {
  workflowId: string;
  workflowName: string;
  paramsSchema: Record<string, unknown> | null | undefined;
  onClose: () => void;
  onRun?: () => void;
}

export function RunWorkflowDialog({
  workflowId,
  workflowName,
  paramsSchema,
  onClose,
  onRun,
}: RunWorkflowDialogProps) {
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const hasParams = Object.keys(params).length > 0;
      await api.runWorkflow(workflowId, hasParams ? params : null);
      toast.success("Workflow run started");
      onRun?.();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start workflow run";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Play className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-medium">Run Workflow</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-hover text-text-muted transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-4 py-4">
          <p className="text-xs text-text-muted mb-4">
            Start a new run of <span className="font-medium text-text">{workflowName}</span>
          </p>
          <WorkflowParamsForm
            paramsSchema={paramsSchema ?? null}
            value={params}
            onChange={setParams}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 text-xs text-error bg-error/5 border-t border-error/20">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-md bg-bg-hover text-text-muted text-sm hover:bg-bg-hover/80 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
