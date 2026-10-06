"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { WorkflowParamsForm } from "./workflow-params-form";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
  const router = useRouter();
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const hasParams = Object.keys(params).length > 0;
      const res = await api.runWorkflow(workflowId, hasParams ? params : null);
      toast.success("Task run started");
      onRun?.();
      onClose();
      const runId = (res as any).run?.id;
      if (runId) {
        router.push(`/jobs/${workflowId}/runs/${runId}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start job run";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      title="Run Task"
      description={
        <>
          Start a new run of <span className="font-medium text-text">{workflowName}</span>.
        </>
      }
      onClose={onClose}
      busy={submitting}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : <Play />}Run
          </Button>
        </>
      }
    >
      <WorkflowParamsForm paramsSchema={paramsSchema ?? null} value={params} onChange={setParams} />

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-sm text-error"
        >
          {error}
        </div>
      )}
    </Dialog>
  );
}
