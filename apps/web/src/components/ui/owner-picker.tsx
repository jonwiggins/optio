"use client";

import { Building2, Lock } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";

/**
 * The Owner row every create / edit form shows: **Organization** or
 * **Private**. One label, one helper sentence per resource, one disabled
 * reason when the organization's needs an admin the viewer isn't.
 *
 *   <OwnerPicker value={scope} onChange={setScope} what="secret" canOrg={isAdmin} />
 */
export function OwnerPicker({
  value,
  onChange,
  what,
  canOrg = true,
  orgNeeds = "admin",
  orgHint,
  privateHint,
  label = "Owner",
  disabledReason,
  size = "sm",
}: {
  value: "organization" | "private";
  onChange: (v: "organization" | "private") => void;
  /** The resource, singular, for the helper sentence ("secret", "connection"). */
  what: string;
  /** Whether the viewer may make the organization's (an admin, for most kinds). */
  canOrg?: boolean;
  orgNeeds?: "admin" | "member";
  /** Replace the default helper sentences. */
  orgHint?: string;
  privateHint?: string;
  label?: string | null;
  /** Lock the whole choice (e.g. a saved row whose scope can't move), with the reason. */
  disabledReason?: string | null;
  size?: "sm" | "md";
}) {
  const hint =
    value === "private"
      ? (privateHint ??
        `Only you see this ${what}, and only your work can use it. Admins see that it exists.`)
      : (orgHint ?? `Everyone in the workspace sees and can use this ${what}.`);
  return (
    <div>
      {label && <span className="block text-xs text-text-muted mb-1">{label}</span>}
      <Segmented
        aria-label={label ?? "Owner"}
        size={size}
        wrap
        value={value}
        onChange={onChange}
        options={[
          {
            value: "organization",
            label: "Organization",
            icon: <Building2 className="w-3 h-3" />,
            disabled:
              disabledReason ??
              (canOrg
                ? undefined
                : `Only ${orgNeeds === "admin" ? "an admin" : "a member"} can make this ${what} the organization's`),
          },
          {
            value: "private",
            label: "Private",
            icon: <Lock className="w-3 h-3" />,
            disabled: disabledReason ?? undefined,
          },
        ]}
      />
      <p className="text-[11px] text-text-muted/80 mt-1.5">{hint}</p>
    </div>
  );
}
