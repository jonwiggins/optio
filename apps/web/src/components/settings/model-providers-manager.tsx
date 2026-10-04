"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Cloud, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import {
  MODEL_PROVIDER_AGENTS,
  MODEL_PROVIDER_POD_CREDENTIALS,
  type ModelProvider,
  type ResourceOwner,
} from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { ownerOf, privateHint, scopeOf } from "@/lib/owner";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Segmented } from "@/components/ui/segmented";
import { SectionCard } from "@/components/ui/section-card";
import { OwnerPicker } from "@/components/ui/owner-picker";
import { OwnerChip } from "@/components/ui/owner-chip";
import { ScopedList } from "@/components/ui/scoped-list";
import { EmptyState } from "@/components/empty-state";
import { SkeletonCard } from "./settings-ui";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
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

const INPUT = inputClass();
const LABEL = "block text-xs text-text-muted mb-1";

/**
 * Settings → Model providers: saved ways for an agent to reach its models
 * (Amazon Bedrock for Claude Code and Codex), the organization's or private.
 * Listed by scope — Organization / Private, plus Other people's for an admin,
 * read-only. Work picks one in its Who section.
 */
export function ModelProvidersManager() {
  const { userId, isAdmin } = useCurrentUser();
  const [providers, setProviders] = useState<ModelProvider[] | null>(null);
  // null = closed; "new" = creating; otherwise the provider being edited.
  const [editing, setEditing] = useState<"new" | ModelProvider | null>(null);
  // The owner a new provider starts on: the section whose "+ New" opened it.
  const [newOwner, setNewOwner] = useState<ResourceOwner | null>(null);

  const load = () =>
    api
      .listModelProviders()
      .then((r) => setProviders(r.providers ?? []))
      .catch(() => setProviders([]));

  useEffect(() => {
    load();
  }, []);

  const openNew = (scope?: "organization" | "private") => {
    setNewOwner(scope ? ownerOf(scope === "organization" && !isAdmin ? "private" : scope) : null);
    setEditing("new");
  };

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
          <Button variant="secondary" size="sm" onClick={() => openNew()}>
            <Plus />
            Add provider
          </Button>
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
          initialOwner={editing === "new" ? newOwner : null}
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
        <ScopedList
          rows={providers}
          filter="all"
          viewerId={userId}
          className="space-y-3"
          privateEmpty={privateHint("model providers")}
          sectionActions={(scope) =>
            scope === "others" || editing !== null ? null : (
              <button
                type="button"
                onClick={() => openNew(scope)}
                className="text-primary hover:underline"
              >
                + New
              </button>
            )
          }
          render={(rows, scope) =>
            rows.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 bg-bg">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium truncate">{p.name}</span>
                    <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">
                      Bedrock
                    </span>
                    {/* Sections already say the scope; the chip is for a flat list. */}
                    {scope === null && <OwnerChip row={p} viewerId={userId} />}
                    {scope === "others" && (
                      <span className="text-[11px] text-text-muted">
                        {p.ownerName ?? "someone"}
                      </span>
                    )}
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
              </div>
            ))
          }
        />
      )}
    </SectionCard>
  );
}

function ProviderEditor({
  original,
  initialOwner,
  isAdmin,
  onDone,
}: {
  original: ModelProvider | null;
  /** For a new provider: the owner to start on (null = what the viewer may make). */
  initialOwner?: ResourceOwner | null;
  isAdmin: boolean;
  onDone: (saved: boolean) => void;
}) {
  const creating = original === null;
  const [form, setForm] = useState<ProviderForm>(() =>
    original
      ? formFromProvider(original)
      : { ...emptyProviderForm(isAdmin), ...(initialOwner ? { owner: initialOwner } : {}) },
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
        <OwnerPicker
          what="model provider"
          value={scopeOf(form.owner)}
          onChange={(v) => set({ owner: ownerOf(v) })}
          canOrg={isAdmin}
        />
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
          <Button variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !!error}>
            {saving && <Loader2 className="animate-spin" />}
            {creating ? "Add provider" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
