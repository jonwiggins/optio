"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api-client";
import { Loader2, Plus, Trash2, GitBranch, Play, ChevronDown, ChevronRight, X } from "lucide-react";
import { toast } from "sonner";

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [promptTemplate, setPromptTemplate] = useState("");
  const [agentRuntime, setAgentRuntime] = useState("claude-code");
  const [model, setModel] = useState("");
  const [maxTurns, setMaxTurns] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState("1");
  const [maxRetries, setMaxRetries] = useState("3");
  const [enabled, setEnabled] = useState(true);

  const loadWorkflows = () => {
    api
      .listWorkflows()
      .then((res) => setWorkflows(res.workflows))
      .catch(() => toast.error("Failed to load workflows"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadWorkflows();
  }, []);

  const resetForm = () => {
    setName("");
    setPromptTemplate("");
    setAgentRuntime("claude-code");
    setModel("");
    setMaxTurns("");
    setMaxConcurrent("1");
    setMaxRetries("3");
    setEnabled(true);
    setShowForm(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return toast.error("Name is required");
    if (!promptTemplate.trim()) return toast.error("Prompt template is required");

    setSubmitting(true);
    try {
      await api.createWorkflow({
        name,
        promptTemplate,
        agentRuntime: agentRuntime || undefined,
        model: model || undefined,
        maxTurns: maxTurns ? parseInt(maxTurns, 10) : undefined,
        maxConcurrent: maxConcurrent ? parseInt(maxConcurrent, 10) : undefined,
        maxRetries: maxRetries ? parseInt(maxRetries, 10) : undefined,
        enabled,
      });
      toast.success("Workflow created");
      resetForm();
      loadWorkflows();
    } catch (err) {
      toast.error("Failed to create workflow", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this workflow?")) return;
    try {
      await api.deleteWorkflow(id);
      toast.success("Workflow deleted");
      loadWorkflows();
    } catch {
      toast.error("Failed to delete");
    }
  };

  const handleRun = async (id: string) => {
    setRunningId(id);
    try {
      await api.runWorkflow(id);
      toast.success("Workflow run queued");
    } catch (err) {
      toast.error("Failed to run workflow", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setRunningId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text">Workflows</h1>
          <p className="text-sm text-text-muted mt-1">
            Define reusable workflow definitions with prompt templates, parameters, and triggers
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 bg-primary text-white px-4 py-2 rounded-lg text-sm hover:bg-primary/90"
        >
          <Plus className="w-4 h-4" />
          New Workflow
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-bg-card border border-border rounded-xl p-6 space-y-4"
        >
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Code Review Pipeline"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-text"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-1">Agent Runtime</label>
              <select
                value={agentRuntime}
                onChange={(e) => setAgentRuntime(e.target.value)}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-text"
              >
                <option value="claude-code">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="copilot">Copilot</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text mb-1">Prompt Template</label>
            <textarea
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              placeholder="Enter the prompt template for this workflow..."
              rows={4}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-text"
            />
          </div>

          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-text mb-1">Model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g., opus"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-text"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-1">Max Turns</label>
              <input
                type="number"
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value)}
                placeholder="250"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-text"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-1">Max Concurrent</label>
              <input
                type="number"
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(e.target.value)}
                placeholder="1"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-text"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-1">Max Retries</label>
              <input
                type="number"
                value={maxRetries}
                onChange={(e) => setMaxRetries(e.target.value)}
                placeholder="3"
                className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-bg text-text"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              id="workflow-enabled"
              className="rounded"
            />
            <label htmlFor="workflow-enabled" className="text-sm text-text">
              Enabled
            </label>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="bg-primary text-white px-4 py-2 rounded-lg text-sm hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create Workflow"}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="px-4 py-2 rounded-lg text-sm border border-border text-text hover:bg-bg-hover"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {workflows.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          <GitBranch className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p>No workflows yet</p>
          <p className="text-sm mt-1">
            Create a workflow to define reusable agent execution patterns
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {workflows.map((w) => {
            const isExpanded = expandedId === w.id;
            return (
              <div key={w.id} className="bg-bg-card border border-border rounded-xl">
                <div className="flex items-center justify-between p-4">
                  <button
                    className="flex items-center gap-3 text-left flex-1"
                    onClick={() => setExpandedId(isExpanded ? null : w.id)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-text-muted" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-text-muted" />
                    )}
                    <div>
                      <div className="font-medium text-sm text-text">{w.name}</div>
                      <div className="text-xs text-text-muted">
                        {w.agentRuntime} &middot;{" "}
                        <span className={w.enabled ? "text-green-400" : "text-text-muted"}>
                          {w.enabled ? "enabled" : "disabled"}
                        </span>
                      </div>
                    </div>
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleRun(w.id)}
                      disabled={runningId === w.id || !w.enabled}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-green-500/10 text-green-400 hover:bg-green-500/20 disabled:opacity-50"
                    >
                      {runningId === w.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Play className="w-3.5 h-3.5" />
                      )}
                      Run
                    </button>
                    <button
                      onClick={() => handleDelete(w.id)}
                      className="p-1.5 rounded-lg text-text-muted hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="border-t border-border p-4 space-y-2">
                    <div className="text-sm text-text-muted">
                      <strong>Prompt Template:</strong>
                      <pre className="mt-1 text-xs bg-bg rounded-lg p-3 whitespace-pre-wrap">
                        {w.promptTemplate}
                      </pre>
                    </div>
                    <div className="grid grid-cols-4 gap-4 text-xs text-text-muted">
                      <div>
                        <strong>Model:</strong> {w.model ?? "default"}
                      </div>
                      <div>
                        <strong>Max Turns:</strong> {w.maxTurns ?? "default"}
                      </div>
                      <div>
                        <strong>Max Concurrent:</strong> {w.maxConcurrent}
                      </div>
                      <div>
                        <strong>Max Retries:</strong> {w.maxRetries}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
