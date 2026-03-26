"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api-client";
import { Loader2, Plus, Trash2, FileText, Pencil } from "lucide-react";
import { toast } from "sonner";

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [repos, setRepos] = useState<any[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    name: "",
    prompt: "",
    repoUrl: "",
    agentType: "claude-code",
    priority: 100,
  });

  const loadTemplates = () => {
    api
      .listTaskTemplates()
      .then((res) => setTemplates(res.templates))
      .catch(() => toast.error("Failed to load templates"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadTemplates();
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {});
  }, []);

  const resetForm = () => {
    setForm({ name: "", prompt: "", repoUrl: "", agentType: "claude-code", priority: 100 });
    setEditingId(null);
    setShowForm(false);
  };

  const handleEdit = (template: any) => {
    setForm({
      name: template.name,
      prompt: template.prompt,
      repoUrl: template.repoUrl ?? "",
      agentType: template.agentType,
      priority: template.priority,
    });
    setEditingId(template.id);
    setShowForm(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const data = {
        name: form.name,
        prompt: form.prompt,
        repoUrl: form.repoUrl || undefined,
        agentType: form.agentType,
        priority: form.priority,
      };

      if (editingId) {
        await api.updateTaskTemplate(editingId, data);
        toast.success("Template updated");
      } else {
        await api.createTaskTemplate(data);
        toast.success("Template created");
      }
      resetForm();
      loadTemplates();
    } catch (err) {
      toast.error(editingId ? "Failed to update template" : "Failed to create template", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete template "${name}"?`)) return;
    try {
      await api.deleteTaskTemplate(id);
      toast.success("Template deleted");
      loadTemplates();
    } catch {
      toast.error("Failed to delete template");
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Task Templates</h1>
        <button
          onClick={() => {
            if (showForm && !editingId) {
              resetForm();
            } else {
              resetForm();
              setShowForm(true);
            }
          }}
          className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Template
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="mb-6 p-5 rounded-xl border border-border/50 bg-bg-card space-y-3"
        >
          <div>
            <label className="block text-sm text-text-muted mb-1.5">Template Name</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Bug fix template"
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm text-text-muted mb-1.5">Repository (optional)</label>
            <select
              value={form.repoUrl}
              onChange={(e) => setForm((f) => ({ ...f, repoUrl: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
            >
              <option value="">Any repository</option>
              {repos.map((repo: any) => (
                <option key={repo.id} value={repo.repoUrl}>
                  {repo.fullName}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-text-muted mb-1.5">Prompt</label>
            <textarea
              required
              rows={4}
              value={form.prompt}
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
              placeholder="Describe the task for the agent..."
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors resize-y"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-text-muted mb-1.5">Agent</label>
              <select
                value={form.agentType}
                onChange={(e) => setForm((f) => ({ ...f, agentType: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
              >
                <option value="claude-code">Claude Code</option>
                <option value="codex">OpenAI Codex</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-text-muted mb-1.5">Priority</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={form.priority}
                onChange={(e) =>
                  setForm((f) => ({ ...f, priority: parseInt(e.target.value, 10) || 100 }))
                }
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
            >
              {submitting ? "Saving..." : editingId ? "Update Template" : "Save Template"}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="px-4 py-2 rounded-md bg-bg-hover text-text-muted text-sm font-medium hover:text-text transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading templates...
        </div>
      ) : templates.length === 0 ? (
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-xl">
          <FileText className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No task templates yet</p>
          <p className="text-xs mt-1">Create a template to save and reuse task configurations.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex items-start justify-between p-4 rounded-xl border border-border/50 bg-bg-card"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{template.name}</span>
                  <span className="text-xs text-text-muted bg-bg-hover px-1.5 py-0.5 rounded">
                    {template.agentType}
                  </span>
                  {template.repoUrl && (
                    <span className="text-xs text-text-muted bg-bg-hover px-1.5 py-0.5 rounded truncate max-w-[200px]">
                      {template.repoUrl.replace("https://github.com/", "")}
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-1 line-clamp-2">{template.prompt}</p>
              </div>
              <div className="flex items-center gap-1 ml-3 shrink-0">
                <button
                  onClick={() => handleEdit(template)}
                  className="p-1.5 rounded-md text-text-muted hover:text-text hover:bg-bg-hover transition-colors"
                  title="Edit"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDelete(template.id, template.name)}
                  className="p-1.5 rounded-md text-text-muted hover:text-error hover:bg-bg-hover transition-colors"
                  title="Delete"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
