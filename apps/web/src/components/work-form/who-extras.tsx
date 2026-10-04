"use client";

import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2, Plus, X } from "lucide-react";
import type { ModelProvider, PickableSecret, ResourceOwner } from "@optio/shared";
import { api } from "@/lib/api-client";
import { ownerOf, scopeOf } from "@/lib/owner";
import { Segmented } from "@/components/ui/segmented";
import { OwnerPicker } from "@/components/ui/owner-picker";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

/**
 * The Who section's ownership rows: which model provider the agent reaches
 * its models through, who owns the work, and which secrets its pod gets.
 */

const DEFAULT = "__default__";

/** `Default` + each usable provider. Hidden by the caller when there are none. */
export function ProviderRow({
  providers,
  picked,
  disabledReason,
  onPick,
}: {
  providers: ModelProvider[];
  picked: ModelProvider | undefined;
  disabledReason: (p: ModelProvider) => string | undefined;
  onPick: (p: ModelProvider | null) => void;
}) {
  const reasons = providers.map((p) => [p, disabledReason(p)] as const).filter(([, r]) => r);
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">Provider</label>
      <Segmented
        wrap
        value={picked?.id ?? DEFAULT}
        onChange={(id) =>
          onPick(id === DEFAULT ? null : (providers.find((p) => p.id === id) ?? null))
        }
        options={[
          { value: DEFAULT, label: "Default" },
          ...providers.map((p) => ({
            value: p.id,
            label: p.mine ? `${p.name} (private)` : p.name,
            disabled: disabledReason(p),
          })),
        ]}
      />
      <p className="text-[11px] text-text-muted/80 mt-1.5">
        {picked
          ? `Reaches its models through ${picked.name} (${picked.region}).`
          : "Default uses the agent's usual sign-in."}
        {reasons.length > 0 && ` ${reasons[0][0].name}: ${reasons[0][1]}.`}
      </p>
    </div>
  );
}

const PRIVATE_WORK_HINT =
  "Runs with your own secrets, model providers and connections. Only you see it; admins see that it exists.";
const ORG_WORK_HINT =
  "Uses the organization's secrets, providers and connections. Everyone in the workspace sees it.";

/**
 * The work's Owner: the organization, or you. Speaks `ResourceOwner`
 * (`workspace` / `me`) to the form; `note` (why a pick switched the owner)
 * replaces the helper sentence.
 */
export function OwnerRow({
  owner,
  onChange,
  note,
}: {
  owner: ResourceOwner;
  onChange: (owner: ResourceOwner) => void;
  note?: string | null;
}) {
  return (
    <OwnerPicker
      label="Owner"
      what="work"
      value={scopeOf(owner)}
      onChange={(v) => onChange(ownerOf(v))}
      privateHint={note ?? PRIVATE_WORK_HINT}
      orgHint={note ?? ORG_WORK_HINT}
    />
  );
}

/** Picked secret names, "+ Add secret" from the pickable list, and "New secret…" inline. */
export function SecretsRow({
  picked,
  pickable,
  addable,
  canCreateOrg,
  onAdd,
  onRemove,
  onCreated,
}: {
  picked: string[];
  pickable: PickableSecret[];
  addable: PickableSecret[];
  canCreateOrg: boolean;
  onAdd: (s: PickableSecret) => void;
  onRemove: (name: string) => void;
  onCreated: (s: PickableSecret) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [owner, setOwner] = useState<ResourceOwner>("me");
  const [saving, setSaving] = useState(false);

  const tagFor = (n: string) => {
    const owners = pickable.filter((s) => s.name === n).map((s) => s.owner);
    if (owners.includes("workspace") && owners.includes("me")) return "organization + private";
    if (owners.includes("me")) return "private";
    if (owners.includes("workspace")) return "organization";
    return null;
  };

  /** A new secret starts as the organization's for an admin, private otherwise. */
  const startCreating = () => {
    setOwner(canCreateOrg ? "workspace" : "me");
    setCreating(true);
  };

  const create = async () => {
    const n = name.trim();
    if (!n || !value) return;
    setSaving(true);
    try {
      await api.createSecret(
        owner === "me" ? { name: n, value, scope: "user" } : { name: n, value },
      );
      onCreated({ name: n, owner });
      setName("");
      setValue("");
      setCreating(false);
    } catch (err) {
      toast.error("Couldn't save the secret", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">Secrets</label>
      <div className="flex flex-wrap items-center gap-1.5">
        {picked.map((n) => {
          const tag = tagFor(n);
          return (
            <span
              key={n}
              className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-bg border border-border text-xs font-mono"
            >
              <KeyRound className="w-3 h-3 text-text-muted" />
              {n}
              {tag && <span className="font-sans text-[10px] text-text-muted">{tag}</span>}
              <button
                type="button"
                onClick={() => onRemove(n)}
                className="p-0.5 rounded text-text-muted hover:text-text"
                aria-label={`Remove ${n}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          );
        })}
        {addable.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const [o, ...rest] = e.target.value.split(":");
              const s = addable.find((x) => x.owner === o && x.name === rest.join(":"));
              if (s) onAdd(s);
            }}
            className={inputClass({ size: "sm", className: "w-auto text-text-muted" })}
            aria-label="Add secret"
          >
            <option value="">+ Add secret</option>
            {addable.map((s) => (
              <option key={`${s.owner}:${s.name}`} value={`${s.owner}:${s.name}`}>
                {s.name} ({s.owner === "me" ? "private" : "organization"})
              </option>
            ))}
          </select>
        )}
        {!creating && (
          <Button variant="ghost" size="sm" onClick={startCreating}>
            <Plus />
            New secret…
          </Button>
        )}
      </div>
      {creating && (
        <div className="mt-2 p-3 rounded-lg bg-bg border border-border space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value.replace(/\s/g, "_"))}
              placeholder="NAME"
              className={inputClass({ className: "font-mono" })}
              aria-label="Secret name"
            />
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Value"
              className={inputClass()}
              aria-label="Secret value"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <OwnerPicker
              label={null}
              what="secret"
              value={scopeOf(owner)}
              onChange={(v) => setOwner(ownerOf(v))}
              canOrg={canCreateOrg}
            />
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" type="button" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={create}
                disabled={saving || !name.trim() || !value}
              >
                {saving && <Loader2 className="animate-spin" />}
                Save and add
              </Button>
            </div>
          </div>
        </div>
      )}
      <p className="text-[11px] text-text-muted/80 mt-1.5">
        Only what you pick is available to the agent.
      </p>
    </div>
  );
}
