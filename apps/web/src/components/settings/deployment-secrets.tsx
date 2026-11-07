"use client";

import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type VisibleSecret } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { SectionCard } from "@/components/ui/section-card";
import { inputClass } from "@/components/ui/input";
import {
  BTN_HEADER,
  BTN_PRIMARY,
  BTN_ROW_DANGER,
  BTN_TEXT,
  Field,
  INPUT,
  InsetForm,
  LIST,
  ListRow,
  SkeletonCard,
  Tag,
} from "@/components/settings/settings-ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The deployment's own secrets — agent sign-in, Optio settings, git access —
 * which the Connections catalog leaves out. Everything work connects to
 * (service credentials, bare secrets, MCP servers) is under Library → Connections.
 */
export function DeploymentSecrets() {
  // The server takes a deployment admin for these, whatever the workspace role.
  const { isDeploymentAdmin, loaded } = useCurrentUser();
  const [secrets, setSecrets] = useState<VisibleSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () =>
    api
      .listSecrets(undefined, { deployment: true })
      .then((res) => setSecrets(res.secrets))
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const label = "Deployment secrets";
  const hint = "Agent sign-in, Optio settings, git access";
  if (loading || !loaded) return <SkeletonCard label={label} hint={hint} rows={2} />;

  const reset = () => {
    setShowAdd(false);
    setName("");
    setValue("");
  };

  const add = async () => {
    if (!name || !value) {
      toast.error("Name and value are required");
      return;
    }
    setSaving(true);
    try {
      await api.createSecret({ name, value, scope: "global" });
      toast.success("Secret saved", { description: `${name} has been encrypted and stored.` });
      reset();
      void load();
    } catch (err) {
      toast.error("Failed to save secret", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (secret: VisibleSecret) => {
    if (!window.confirm(`Delete ${secret.name}? Pods stop receiving it.`)) return;
    try {
      await api.deleteSecret(secret.name, secret.scope);
      toast.success("Secret deleted");
      void load();
    } catch {
      toast.error("Failed to delete secret");
    }
  };

  const scopeTag = (scope: string) =>
    scope === "global" ? "all repos" : scope.replace(/^https?:\/\//, "");

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={secrets.length ? plural(secrets.length, "secret") : undefined}
      actions={
        isDeploymentAdmin &&
        !showAdd && (
          <button onClick={() => setShowAdd(true)} className={BTN_HEADER}>
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        )
      }
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        The deployment's own secrets — agent sign-in, Optio settings, git access. Everything work
        connects to lives under Library → Connections.
      </p>

      {secrets.length > 0 ? (
        <ul className={LIST}>
          {secrets.map((secret) => (
            <ListRow
              key={secret.id}
              title={
                <span className="inline-flex items-center gap-2 font-mono">
                  <KeyRound className="w-3.5 h-3.5 text-text-muted shrink-0" />
                  {secret.name}
                </span>
              }
              tags={<Tag>{scopeTag(secret.scope)}</Tag>}
              actions={
                isDeploymentAdmin && (
                  <button
                    onClick={() => remove(secret)}
                    className={BTN_ROW_DANGER}
                    aria-label={`Delete ${secret.name}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )
              }
            />
          ))}
        </ul>
      ) : (
        !showAdd && (
          <p className="text-xs text-text-muted">
            No deployment secrets yet — add the agent's API key or an OAuth token here.
          </p>
        )
      )}

      {showAdd && (
        <InsetForm>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ANTHROPIC_API_KEY"
                aria-label="Deployment secret name"
                className={inputClass({ className: "font-mono" })}
              />
            </Field>
            <Field label="Value">
              <input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="sk-ant-..."
                aria-label="Deployment secret value"
                autoComplete="off"
                className={INPUT}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={reset} className={BTN_TEXT}>
              Cancel
            </button>
            <button onClick={add} disabled={saving} className={BTN_PRIMARY}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </InsetForm>
      )}
    </SectionCard>
  );
}
