"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { WorkflowForm } from "../workflow-form";

export default function NewWorkflowPage() {
  usePageTitle("New Workflow");

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-6">Create New Workflow</h1>
      <WorkflowForm mode="create" />
    </div>
  );
}
