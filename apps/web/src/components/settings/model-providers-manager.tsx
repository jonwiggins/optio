"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Building2, Cloud, Loader2, Pencil, Plus, Trash2, User } from "lucide-react";
import {
  canManageOrgResources,
  MODEL_PROVIDER_AGENTS,
  MODEL_PROVIDER_POD_CREDENTIALS,
  type ModelProvider,
  type WorkspaceRole,
} from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import { SectionCard } from "@/components/ui/section-card";
import { EmptyState } from "@/components/empty-state";
import { BTN_HEADER, SkeletonCard } from "./settings-ui";
import {
  AGENT_LABELS,
  POD_CREDENTIAL_LABELS,
  emptyProviderForm,
  formFromProvider,
  formatModels,
  parseModels,
  podsLabel,
  toCreateInput,
  toUpdateInput,
  toggleAgent,
  validateProviderForm,
  withRegion,
  type ProviderForm,
} from "./model-provider-form";

const INPUT =
  "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20";
const LABEL = "block text-xs text-text-muted mb-1";

/**
 * Settings → Model providers: saved ways for an agent to reach its models
 * (Amazon Bedrock for Claude Code and Codex), owned by the organization or
 * by you. Work picks one in its Who section.
 */
export function ModelProvidersManager() {
  const [providers, setProviders] = useState<ModelProvider[] | null>(null);
  const [role, setRole] = useState<WorkspaceRole | null>(null);
  // null = closed; "new" = creating; otherwise the provider being edited.
  const [editing, setEditing] = useState<"new" | ModelProvider | null>(null);

  const load = () =>
    api
      .listModelProviders()
      .then((r) => setProviders(r.providers ?? []))
      .catch(() => setProviders([]));

  useEffect(() => {
    load();
    api
      .getCurrentUser()
      .then((r) => setRole((r.user.workspaceRole as WorkspaceRole) ?? null))
      .catch(() => {});
  }, []);

  const isAdmin = canManageOrgResources(role);

  const remove = async (p: ModelProvider) => {
    if (!confirm(`Delete ${p.name}? Work that picks it falls back to Default.`)) return;
    try {
      await api.deleteModelProvider(p.id);
      toast.success(`${p.name} deleted`);
      load();
    } catch (err) {
      toast.error("Couldn't delete it", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const label = "Model providers";
  const hint = "Where agents reach their models";
  if (providers === null) {
    return <SkeletonCard id="model-providers" label={label} hint={hint} rows={1} />;
  }

  return (
    <SectionCard
      id="model-providers"
      label={label}
      hint={hint}
      summary={
        providers.length
          ? `${providers.length} provider${providers.length === 1 ? "" : "s"}`
          : undefined
      }
      actions={
        editing === null && (
          <button type="button" onClick={() => setEditing("new")} className={BTN_HEADER}>
            <Plus className="w-3.5 h-3.5" />
            Add provider
          </button>
        )
      }
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted">
        A saved way for an agent to reach its models — today Amazon Bedrock for Claude Code and
        Codex. Work picks one under Who.
      </p>

      {editing !== null && (
        <ProviderEditor
          key={editing === "new" ? "new" : editing.id}
          original={editing === "new" ? null : editing}
          isAdmin={isAdmin}
          onDone={(saved) => {
            setEditing(null);
            if (saved) load();
          }}
        />
      )}

      {providers.length === 0 ? (
        editing === null && (
          <EmptyState
            size="panel"
            icon={Cloud}
            title="No model providers yet"
            description="Until you add one, work uses the Default way to reach its models."
          />
        )
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border bg-bg">
          {providers.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium truncate">{p.name}</span>
                  <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">
                    Bedrock
                  </span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-text-muted">
                    {p.ownerUserId ? (
                      <>
                        <User className="w-3 h-3" />
                        {p.mine ? "Just me" : (p.ownerName ?? "Someone's own")}
                      </>
                    ) : (
                      <>
                        <Building2 className="w-3 h-3" />
                        Organization
                      </>
                    )}
                  </span>
                </div>
                <p className="text-xs text-text-muted mt-0.5">
                  {p.agents.map((a) => AGENT_LABELS[a]).join(", ")} · {p.region} · {podsLabel(p)}
                  {p.localAwsProfile ? ` · AWS profile ${p.localAwsProfile} on machines` : ""}
                </p>
              </div>
              {p.canEdit && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    className="p-1.5 rounded text-text-muted hover:text-text hover:bg-bg-hover"
                    aria-label={`Edit ${p.name}`}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(p)}
                    className="p-1.5 rounded text-text-muted hover:text-error hover:bg-bg-hover"
                    aria-label={`Delete ${p.name}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function ProviderEditor({
  original,
  isAdmin,
  onDone,
}: {
  original: ModelProvider | null;
  isAdmin: boolean;
  onDone: (saved: boolean) => void;
}) {
  const creating = original === null;
  const [form, setForm] = useState<ProviderForm>(() =>
    original ? formFromProvider(original) : emptyProviderForm(isAdmin),
  );
  // Model lists as typed (one per line), parsed on change.
  const [modelText, setModelText] = useState<Record<string, string>>(() =>
    Object.fromEntries(MODEL_PROVIDER_AGENTS.map((a) => [a, formatModels(form.models[a])])),
  );
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<ProviderForm>) => setForm((f) => ({ ...f, ...patch }));
  const syncText = (f: ProviderForm) =>
    setModelText(
      Object.fromEntries(MODEL_PROVIDER_AGENTS.map((a) => [a, formatModels(f.models[a])])),
    );

  const error = validateProviderForm(form, creating);
  const stores = form.podCredential === "access-key" || form.podCredential === "bearer-token";
  // Stored credentials of the kind picked now (Replace / Clear / Keep apply).
  const sameStored = !!original?.hasPodCredentials && original.podCredential === form.podCredential;
  const showCredFields = stores && (creating || form.credentialAction === "replace");

  const save = async () => {
    if (error) return;
    setSaving(true);
    try {
      if (original) await api.updateModelProvider(original.id, toUpdateInput(form, original));
      else await api.createModelProvider(toCreateInput(form));
      toast.success(`${form.name.trim()} saved`);
      onDone(true);
    } catch (err) {
      toast.error("Couldn't save it", {
        description: err instanceof Error ? err.message : undefined,
      });
      setSaving(false);
    }
  };

  return (
    <div className="p-4 rounded-lg border border-primary/30 bg-primary/5 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL}>Name</label>
          <input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            className={INPUT}
          />
        </div>
        <div>
          <label className={LABEL}>Owner</label>
          <Segmented
            value={form.owner}
            onChange={(owner) => set({ owner })}
            options={[
              {
                value: "workspace",
                label: "Organization",
                icon: <Building2 className="w-3 h-3" />,
                disabled: isAdmin ? undefined : "Only admins add organization providers",
              },
              { value: "me", label: "Just me", icon: <User className="w-3 h-3" /> },
            ]}
          />
        </div>
        <div>
          <label className={LABEL}>Agents</label>
          <div className="flex gap-4 py-1.5">
            {MODEL_PROVIDER_AGENTS.map((a) => (
              <label key={a} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.agents.includes(a)}
                  onChange={(e) => {
                    const next = toggleAgent(form, a, e.target.checked);
                    setForm(next);
                    syncText(next);
                  }}
                  className="w-4 h-4 rounded"
                />
                {AGENT_LABELS[a]}
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className={LABEL}>Region</label>
          <input
            value={form.region}
            onChange={(e) => {
              const next = withRegion(form, e.target.value.trim());
              setForm(next);
              syncText(next);
            }}
            placeholder="us-west-2"
            className={cn(INPUT, "font-mono")}
          />
        </div>
      </div>

      {form.agents.map((a) => (
        <div key={a}>
          <label className={LABEL}>
            {AGENT_LABELS[a]} models{" "}
            <span className="text-text-muted/60">
              (one per line, “id | label”; first is the default)
            </span>
          </label>
          <textarea
            rows={Math.max(2, (modelText[a] ?? "").split("\n").length)}
            value={modelText[a] ?? ""}
            onChange={(e) => {
              setModelText((t) => ({ ...t, [a]: e.target.value }));
              setForm((f) => ({ ...f, models: { ...f.models, [a]: parseModels(e.target.value) } }));
            }}
            className={cn(INPUT, "font-mono text-xs resize-y")}
          />
        </div>
      ))}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-border/50">
        <div>
          <p className="text-xs font-medium mb-2">On your machines</p>
          <label className={LABEL}>AWS profile (optional)</label>
          <input
            value={form.localAwsProfile}
            onChange={(e) => set({ localAwsProfile: e.target.value })}
            placeholder="Blank = the machine's default AWS credentials"
            className={cn(INPUT, "font-mono")}
          />
        </div>
        <div>
          <p className="text-xs font-medium mb-2">In pods</p>
          <Segmented
            wrap
            value={form.podCredential}
            onChange={(c) =>
              set({
                podCredential: c,
                credentialAction:
                  original?.hasPodCredentials && original.podCredential === c ? "keep" : "replace",
              })
            }
            options={MODEL_PROVIDER_POD_CREDENTIALS.map((c) => ({
              value: c,
              label: POD_CREDENTIAL_LABELS[c],
            }))}
          />
          <p className="text-[11px] text-text-muted mt-1.5">
            {form.podCredential === "ambient"
              ? "Uses the pod's own AWS identity (IRSA / instance profile)."
              : form.podCredential === "none"
                ? "Work in a pod can't pick it."
                : "Stored encrypted; never shown again."}
          </p>
          {stores && sameStored && form.credentialAction !== "replace" && (
            <div className="flex items-center gap-2 mt-2 text-xs">
              <span className={form.credentialAction === "clear" ? "text-warning" : "text-success"}>
                {form.credentialAction === "clear" ? "Will be cleared" : "Stored"}
              </span>
              <button
                type="button"
                onClick={() => set({ credentialAction: "replace" })}
                className="text-primary hover:underline"
              >
                Replace
              </button>
              {form.credentialAction === "keep" ? (
                <button
                  type="button"
                  onClick={() => set({ credentialAction: "clear" })}
                  className="text-text-muted hover:text-error"
                >
                  Clear
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => set({ credentialAction: "keep" })}
                  className="text-text-muted hover:text-text"
                >
                  Keep
                </button>
              )}
            </div>
          )}
          {showCredFields && (
            <div className="space-y-2 mt-2">
              {form.podCredential === "access-key" ? (
                <>
                  <input
                    value={form.accessKeyId}
                    onChange={(e) => set({ accessKeyId: e.target.value })}
                    placeholder="Access key id"
                    autoComplete="off"
                    className={cn(INPUT, "font-mono")}
                  />
                  <input
                    type="password"
                    value={form.secretAccessKey}
                    onChange={(e) => set({ secretAccessKey: e.target.value })}
                    placeholder="Secret access key"
                    autoComplete="off"
                    className={INPUT}
                  />
                  <input
                    type="password"
                    value={form.sessionToken}
                    onChange={(e) => set({ sessionToken: e.target.value })}
                    placeholder="Session token (optional)"
                    autoComplete="off"
                    className={INPUT}
                  />
                </>
              ) : (
                <input
                  type="password"
                  value={form.bearerToken}
                  onChange={(e) => set({ bearerToken: e.target.value })}
                  placeholder="Bedrock API key"
                  autoComplete="off"
                  className={INPUT}
                />
              )}
              {sameStored && (
                <button
                  type="button"
                  onClick={() => set({ credentialAction: "keep" })}
                  className="text-xs text-text-muted hover:text-text"
                >
                  Keep the stored ones
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pt-3 border-t border-border/50">
        <p className="text-xs text-warning">{error ?? ""}</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onDone(false)}
            className="text-sm text-text-muted hover:text-text"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !!error}
            className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {creating ? "Add provider" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
