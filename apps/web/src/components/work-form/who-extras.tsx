"use client";

import type { ModelProvider, ResourceOwner } from "@optio/shared";
import { ownerOf, scopeOf } from "@/lib/owner";
import { Segmented } from "@/components/ui/segmented";
import { OwnerPicker } from "@/components/ui/owner-picker";

/**
 * The Who section's ownership rows: which model provider the agent reaches
 * its models through, and who owns the work. (What the pod is connected to —
 * secrets included — is the "Connected to" row, components/connections.)
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
