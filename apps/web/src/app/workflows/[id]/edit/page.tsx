"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { WorkflowForm } from "../../workflow-form";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function EditWorkflowPage() {
  const params = useParams();
  const id = params.id as string;
  usePageTitle("Edit Agent Workflow");

  const [workflow, setWorkflow] = useState<any>(null);
  const [triggers, setTriggers] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [wfRes, trRes] = await Promise.all([
          api.getWorkflow(id),
          api.listWorkflowTriggers(id),
        ]);
        setWorkflow(wfRes.workflow);
        setTriggers(trRes.triggers);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to load agent workflow";
        setError(msg);
        toast.error(msg);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading agent workflow...
      </div>
    );
  }

  if (error || !workflow) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <p className="text-sm text-error">{error ?? "Agent workflow not found"}</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">Edit Agent Workflow</h1>
      <WorkflowForm
        mode="edit"
        workflowId={id}
        initialData={workflow}
        initialTriggers={triggers ?? []}
      />
    </div>
  );
}
