"use client";

import { Plus } from "lucide-react";
import type { AgentCredential, ResourceOwner } from "@optio/shared";
import { ownerOf, scopeOf } from "@/lib/owner";
import { Segmented } from "@/components/ui/segmented";
import { OwnerPicker } from "@/components/ui/owner-picker";

/**
 * The Who section's ownership rows: what the agent signs in with (its keys
 * and tokens, or a model provider it reaches its models through), and who
 * owns the work. (What the pod is connected to — secrets included — is the
 * "Connected to" row, components/connections.)
 */

const DEFAULT = "__default__";

export interface SignInOption {
  credential: AgentCredential;
  /** Why it can't be picked here (a machines-only provider, …). */
  disabled?: string;
}

/** The pill text: the label, "(private)" for yours, "· default" for the one a run gets anyway. */
export function signInLabel(c: AgentCredential): string {
  return `${c.label}${c.owner === "me" ? " (private)" : ""}${c.default ? " · default" : ""}`;
}

/**
 * `Default` + every credential the work may sign in with, plus `+` to add
 * one. A value the list no longer has (a removed secret) is shown as such so
 * Default can be picked instead.
 */
export function SignInRow({
  options,
  value,
  onPick,
  onAdd,
  hint,
  loading = false,
}: {
  options: SignInOption[];
  /** The picked credential id (`secret:…` / `provider:…`), or null for Default. */
  value: string | null;
  onPick: (c: AgentCredential | null) => void;
  /** Opens the add dialog; omitted where nothing can be added (work on a machine). */
  onAdd?: () => void;
  /** The sentence under the pills. */
  hint: string;
  loading?: boolean;
}) {
  const known = value === null || options.some((o) => o.credential.id === value);
  const reasons = options.filter((o) => o.disabled);
  return (
    <div data-testid="credential-row">
      <label className="block text-xs text-text-muted mb-1">Signed in with</label>
      <div className="flex flex-wrap items-start gap-2">
        <Segmented
          aria-label="Signed in with"
          wrap
          value={value ?? DEFAULT}
          onChange={(id) =>
            onPick(
              id === DEFAULT
                ? null
                : (options.find((o) => o.credential.id === id)?.credential ?? null),
            )
          }
          options={[
            { value: DEFAULT, label: "Default", testId: "credential-default" },
            ...options.map((o) => ({
              value: o.credential.id,
              label: signInLabel(o.credential),
              disabled: o.disabled,
              testId: `credential-${o.credential.id}`,
            })),
            ...(value !== null && !known && !loading
              ? [
                  {
                    value,
                    label: "Removed credential",
                    disabled: "It was removed — pick another",
                    testId: "credential-removed",
                  },
                ]
              : []),
          ]}
        />
        {onAdd && (
          <button
            type="button"
            data-testid="credential-add"
            aria-label="Add credentials"
            title="Add credentials"
            onClick={onAdd}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-text-muted transition-colors hover:border-primary hover:text-primary"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <p className="text-[11px] text-text-muted/80 mt-1.5">
        {hint}
        {reasons.length > 0 && ` ${reasons[0].credential.label}: ${reasons[0].disabled}.`}
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
