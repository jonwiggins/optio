"use client";

import { Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { usePageTitle } from "@/hooks/use-page-title";
import { useCurrentUser } from "@/hooks/use-current-user";
import { FileText, Loader2, Plus, Trash2, Eye, X, Save, Pencil } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Segmented } from "@/components/ui/segmented";
import { OwnerPicker } from "@/components/ui/owner-picker";
import { OwnerSegments, useOwnerFilter } from "@/components/ui/owner-segments";
import { ScopedList } from "@/components/ui/scoped-list";
import { OwnerChip } from "@/components/ui/owner-chip";
import { countByOwner, inOwnerFilter, ownerOf, ownerScope, privateHint } from "@/lib/owner";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { ManagedChip } from "@/components/ui/managed-chip";
import type { ManagedBy } from "@optio/shared";

type TemplateKind = "prompt" | "review" | "job" | "task";
type PickedScope = "organization" | "private";

interface Template {
  managedBy?: ManagedBy | null;
  id: string;
  name: string;
  template: string;
  kind: TemplateKind;
  description: string | null;
  paramsSchema: Record<string, unknown> | null;
  defaultAgentType: string | null;
  workspaceId: string | null;
  /** null = the organization's; set = someone's private prompt (named by `ownerName`). */
  ownerUserId?: string | null;
  ownerName?: string | null;
  createdAt: string;
  updatedAt: string;
}

const KIND_LABELS: Record<TemplateKind, string> = {
  prompt: "Coding prompt",
  review: "Code review",
  job: "Standalone task prompt",
  task: "Repo task blueprint",
};

const KIND_FILTERS: Array<{ value: TemplateKind | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "prompt", label: "Coding" },
  { value: "review", label: "Review" },
  { value: "job", label: "Standalone" },
  { value: "task", label: "Tasks" },
];

/**
 * Prompts, by kind and by scope: the organization's, the viewer's private
 * ones, and — for an admin, read-only — other people's. "+ New" opens on the
 * scope being viewed.
 */
export default function TemplatesPage() {
  usePageTitle("Prompts");
  return (
    <Suspense fallback={<div className="page-column py-6 h-32 skeleton-shimmer rounded-lg" />}>
      <PromptsList />
    </Suspense>
  );
}

function PromptsList() {
  const { userId, isAdmin } = useCurrentUser();
  const [owner, setOwner] = useOwnerFilter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [filter, setFilter] = useState<TemplateKind | "all">("all");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ template: Template | null; scope: PickedScope } | null>(
    null,
  );

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.listTemplates();
      setTemplates(res.templates as Template[]);
    } catch (err) {
      toast.error("Failed to load prompts", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // The two filters compose: each one's counts are taken within the other.
  const ofKind = templates.filter((t) => filter === "all" || t.kind === filter);
  const ofOwner = inOwnerFilter(templates, owner, userId);
  const countOf = (k: TemplateKind | "all") =>
    k === "all" ? ofOwner.length : ofOwner.filter((t) => t.kind === k).length;
  const counts = countByOwner(templates, userId);

  /** The scope a saved prompt is in, for the editor's locked Owner row. */
  const scopeOfRow = (t: Template): PickedScope =>
    ownerScope(t, userId) === "organization" ? "organization" : "private";

  /** The scope "+ New" opens on: the segment being viewed, else what the viewer makes by default. */
  const openNew = (scope?: PickedScope) => {
    const wanted = scope ?? (owner === "organization" || owner === "private" ? owner : null);
    setEditing({ template: null, scope: wanted ?? (isAdmin ? "organization" : "private") });
  };

  const remove = async (t: Template) => {
    const other = ownerScope(t, userId) === "others";
    const what = other
      ? `${t.ownerName ?? "their"}'s private prompt "${t.name}"`
      : `prompt "${t.name}"`;
    if (!confirm(`Delete ${what}?`)) return;
    try {
      await api.deleteNamedTemplate(t.id);
      await load();
    } catch (err) {
      toast.error("Failed to delete", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const newButton = (scope?: PickedScope, small = false) =>
    small ? (
      <button type="button" onClick={() => openNew(scope)} className="text-primary hover:underline">
        + New
      </button>
    ) : (
      <Button onClick={() => openNew(scope)}>
        <Plus />
        New prompt
      </Button>
    );

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={FileText}
        title="Prompts"
        description="Reusable prompts. Work can start from one and fill in its {{params}} when it runs."
        meta={
          templates.length > 0 ? (
            <span>
              {templates.length} prompt{templates.length === 1 ? "" : "s"} · {counts.organization}{" "}
              organization · {counts.private} private
              {counts.others > 0 && ` · ${counts.others} other people's`}
            </span>
          ) : null
        }
        actions={newButton()}
      />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Segmented
          size="md"
          surface="card"
          className="gap-1"
          aria-label="Filter by kind"
          value={filter}
          onChange={setFilter}
          options={KIND_FILTERS.map((f) => ({
            value: f.value,
            label: f.label,
            count: countOf(f.value),
          }))}
        />
        {templates.length > 0 && (
          <OwnerSegments rows={ofKind} viewerId={userId} value={owner} onChange={setOwner} />
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 skeleton-shimmer rounded-lg" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No prompts yet"
          description="Save a prompt once and start work from it, with {{params}} filled in at run time."
          action={newButton()}
        />
      ) : ofKind.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No prompts of this kind"
          description="Save a prompt once and start work from it, with {{params}} filled in at run time."
          action={newButton()}
        />
      ) : (
        <ScopedList
          rows={ofKind}
          filter={owner}
          viewerId={userId}
          privateEmpty={privateHint("prompts")}
          sectionActions={(scope) => (scope === "others" ? null : newButton(scope, true))}
          render={(rows, scope) =>
            rows.length === 0 ? (
              <p className="px-4 py-4 text-xs text-text-muted">No prompts in this scope.</p>
            ) : (
              rows.map((t) => {
                // Someone else's private prompt (an admin's view) is read-only; an admin may still delete it.
                const other = ownerScope(t, userId) === "others";
                const edit = () => setEditing({ template: t, scope: scopeOfRow(t) });
                return (
                  <div
                    key={t.id}
                    className="group flex items-start gap-3 px-4 py-3 bg-bg-card/40 hover:bg-bg-hover/60 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <h2 className="text-sm font-medium text-text-heading truncate">
                          {other ? (
                            t.name
                          ) : (
                            <button
                              onClick={edit}
                              className="hover:underline underline-offset-2 text-left"
                            >
                              {t.name}
                            </button>
                          )}
                        </h2>
                        <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-bg-hover text-text-muted">
                          {KIND_LABELS[t.kind] ?? t.kind}
                        </span>
                        {/* Sections already say the scope; the chip is for a flat list. */}
                        {scope === null && <OwnerChip row={t} viewerId={userId} />}
                        <ManagedChip managedBy={t.managedBy} />
                        {scope === "others" && (
                          <span className="shrink-0 text-[11px] text-text-muted">
                            {t.ownerName ?? "someone"}
                          </span>
                        )}
                        {t.defaultAgentType && (
                          <span className="shrink-0 text-[11px] text-text-muted">
                            {t.defaultAgentType}
                          </span>
                        )}
                      </div>
                      {t.description && (
                        <p className="text-[11px] text-text-muted truncate mt-0.5">
                          {t.description}
                        </p>
                      )}
                      <p className="text-[11px] font-mono text-text-muted/80 truncate mt-1">
                        {t.template}
                      </p>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0 opacity-60 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      {!other && (
                        <button
                          onClick={edit}
                          title="Edit"
                          className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {(!other || isAdmin) && (
                        <button
                          onClick={() => remove(t)}
                          title={
                            other ? `Delete ${t.ownerName ?? "their"}'s private prompt` : "Delete"
                          }
                          className="p-1.5 rounded-md hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )
          }
        />
      )}

      {editing && (
        <TemplateEditor
          template={editing.template}
          initialScope={editing.scope}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function TemplateEditor({
  template,
  initialScope,
  onClose,
  onSaved,
}: {
  template: Template | null;
  /** The owner a new prompt starts on; a saved prompt's scope, shown locked. */
  initialScope: PickedScope;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: template?.name ?? "",
    template: template?.template ?? "",
    kind: (template?.kind ?? "prompt") as TemplateKind,
    description: template?.description ?? "",
    defaultAgentType: template?.defaultAgentType ?? "",
  });
  const [scope, setScope] = useState<PickedScope>(initialScope);
  const [previewParams, setPreviewParams] = useState("{}");
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        template: form.template,
        kind: form.kind,
        description: form.description || undefined,
        defaultAgentType: form.defaultAgentType || undefined,
      };
      if (template) {
        // Editing never moves a prompt between scopes.
        await api.updateNamedTemplate(template.id, payload);
      } else {
        await api.createNamedTemplate({ ...payload, owner: ownerOf(scope) });
      }
      toast.success(template ? "Prompt updated" : "Prompt created");
      onSaved();
    } catch (err) {
      toast.error("Save failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    if (!template) {
      toast.info("Save the prompt first to preview.");
      return;
    }
    try {
      const params = JSON.parse(previewParams);
      const res = await api.previewTemplate(template.id, params);
      setPreview(res.rendered);
    } catch (err) {
      toast.error("Preview failed", {
        description: err instanceof Error ? err.message : "Invalid JSON",
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-bg border border-border rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-bg-subtle flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold tracking-tight text-text-heading">
            {template ? "Edit prompt" : "New prompt"}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm text-text-muted mb-1.5">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={inputClass()}
            />
          </div>
          <div>
            <span className="block text-sm text-text-muted mb-1.5">Kind</span>
            <Segmented
              wrap
              aria-label="Kind"
              value={form.kind}
              onChange={(kind) => setForm((f) => ({ ...f, kind }))}
              options={(Object.keys(KIND_LABELS) as TemplateKind[]).map((k) => ({
                value: k,
                label: KIND_LABELS[k],
              }))}
            />
          </div>
          <div>
            <span className="block text-sm text-text-muted mb-1.5">Owner</span>
            <OwnerPicker
              label={null}
              what="prompt"
              value={scope}
              onChange={setScope}
              orgNeeds="member"
              disabledReason={template ? "A saved prompt keeps its scope" : undefined}
            />
          </div>

          <div>
            <label className="block text-sm text-text-muted mb-1.5">Description</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="What is this prompt for?"
              className={inputClass()}
            />
          </div>

          <div>
            <label className="block text-sm text-text-muted mb-1.5">Default agent type</label>
            <input
              type="text"
              value={form.defaultAgentType}
              onChange={(e) => setForm((f) => ({ ...f, defaultAgentType: e.target.value }))}
              placeholder="e.g. claude-code"
              className={inputClass()}
            />
          </div>

          <div>
            <label className="block text-sm text-text-muted mb-1.5">Prompt</label>
            <textarea
              rows={10}
              value={form.template}
              onChange={(e) => setForm((f) => ({ ...f, template: e.target.value }))}
              placeholder={
                "Use {{param}} for substitution.\n{{#if flag}}...{{/if}} for conditionals."
              }
              className={inputClass({ className: "text-xs font-mono" })}
            />
          </div>

          {template && (
            <div className="border border-border rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Preview with params</span>
                <button
                  onClick={handlePreview}
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  <Eye className="w-3.5 h-3.5" />
                  Render
                </button>
              </div>
              <textarea
                rows={3}
                value={previewParams}
                onChange={(e) => setPreviewParams(e.target.value)}
                className={inputClass({ size: "sm", className: "font-mono" })}
                placeholder='{"name": "example"}'
              />
              {preview !== null && (
                <pre className="bg-bg rounded px-2 py-1.5 text-xs font-mono whitespace-pre-wrap border border-border">
                  {preview}
                </pre>
              )}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-bg flex items-center justify-end gap-2 p-4 border-t border-border">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !form.name || !form.template}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
