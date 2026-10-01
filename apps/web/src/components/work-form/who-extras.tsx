"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Building2, KeyRound, Loader2, Plus, User, X } from "lucide-react";
import type { ModelProvider, PickableSecret, ResourceOwner } from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";

/**
 * The Who section's ownership rows: which model provider the agent reaches
 * its models through, who the work runs as, and which secrets its pod gets.
 */

const INPUT =
  "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors";

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
            label: p.mine ? `${p.name} (mine)` : p.name,
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

/** "Runs as": the organization, or you. */
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
    <div>
      <label className="block text-xs text-text-muted mb-1">Runs as</label>
      <Segmented
        wrap
        value={owner}
        onChange={onChange}
        options={[
          {
            value: "workspace",
            label: "Organization",
            icon: <Building2 className="w-3 h-3" />,
          },
          { value: "me", label: "Just me", icon: <User className="w-3 h-3" /> },
        ]}
      />
      <p className="text-[11px] text-text-muted/80 mt-1.5">
        {note ??
          (owner === "me"
            ? "Runs with your own secrets, providers and connections. Others can see it but only you can change it."
            : "Uses the organization's secrets, providers and connections.")}
      </p>
    </div>
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
    if (owners.includes("workspace") && owners.includes("me")) return "org + mine";
    if (owners.includes("me")) return "mine";
    if (owners.includes("workspace")) return "org";
    return null;
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
            className="px-2 py-1 rounded-md bg-bg border border-border text-xs text-text-muted"
            aria-label="Add secret"
          >
            <option value="">+ Add secret</option>
            {addable.map((s) => (
              <option key={`${s.owner}:${s.name}`} value={`${s.owner}:${s.name}`}>
                {s.name} ({s.owner === "me" ? "mine" : "org"})
              </option>
            ))}
          </select>
        )}
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-muted hover:text-text"
          >
            <Plus className="w-3 h-3" />
            New secret…
          </button>
        )}
      </div>
      {creating && (
        <div className="mt-2 p-3 rounded-lg bg-bg border border-border space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value.replace(/\s/g, "_"))}
              placeholder="NAME"
              className={cn(INPUT, "font-mono")}
              aria-label="Secret name"
            />
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Value"
              className={INPUT}
              aria-label="Secret value"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              wrap
              value={owner}
              onChange={setOwner}
              options={[
                { value: "me", label: "Just me", icon: <User className="w-3 h-3" /> },
                {
                  value: "workspace",
                  label: "Organization",
                  icon: <Building2 className="w-3 h-3" />,
                  disabled: canCreateOrg ? undefined : "Only admins add organization secrets",
                },
              ]}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="text-xs text-text-muted hover:text-text"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={create}
                disabled={saving || !name.trim() || !value}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50"
              >
                {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                Save and add
              </button>
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
