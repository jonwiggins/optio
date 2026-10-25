"use client";

import { Building2, Lock, Users } from "lucide-react";
import { teamOwner } from "@optio/shared";
import { Segmented } from "@/components/ui/segmented";
import { inputClass } from "@/components/ui/input";
import { pickedTeamId, type PickedOwner } from "@/lib/owner";
import type { TeamOption } from "@/hooks/use-my-teams";

/**
 * The Owner row every create / edit form shows: **Organization** or
 * **Private** — and, when the viewer is in any team (`teams`), **Team** with
 * a select of theirs. One label, one helper sentence per resource, one
 * disabled reason when the organization's needs an admin the viewer isn't.
 *
 * The value is a `PickedOwner`: a scope word, or `team:<id>` for a team
 * (`ownerOf` turns it into the `owner` the API takes). Callers that offer no
 * teams keep holding `"organization" | "private"`.
 *
 *   <OwnerPicker value={scope} onChange={setScope} what="secret" canOrg={isAdmin} teams={myTeams} />
 */
export function OwnerPicker<T extends PickedOwner = PickedOwner>({
  value,
  onChange,
  what,
  canOrg = true,
  orgNeeds = "admin",
  orgHint,
  privateHint,
  teamHint,
  teams,
  label = "Owner",
  disabledReason,
  size = "sm",
}: {
  value: T;
  onChange: (v: T) => void;
  /** The resource, singular, for the helper sentence ("secret", "connection"). */
  what: string;
  /** Whether the viewer may make the organization's (an admin, for most kinds). */
  canOrg?: boolean;
  orgNeeds?: "admin" | "member";
  /** Replace the default helper sentences. */
  orgHint?: string;
  privateHint?: string;
  teamHint?: string;
  /** The viewer's teams. Given and non-empty, a third option **Team** with a select of them. */
  teams?: TeamOption[];
  label?: string | null;
  /** Lock the whole choice (e.g. a saved row whose scope can't move), with the reason. */
  disabledReason?: string | null;
  size?: "sm" | "md";
}) {
  const teamId = pickedTeamId(value);
  const segment: "organization" | "private" | "team" = teamId
    ? "team"
    : value === "private"
      ? "private"
      : "organization";
  // A saved row's team the viewer isn't in still shows as that team.
  const options: TeamOption[] =
    teamId && !(teams ?? []).some((t) => t.id === teamId)
      ? [...(teams ?? []), { id: teamId, name: "Team" }]
      : (teams ?? []);
  const offerTeam = options.length > 0;
  const hint =
    segment === "private"
      ? (privateHint ??
        `Only you see this ${what}, and only your work can use it. Admins see that it exists.`)
      : segment === "team"
        ? (teamHint ??
          `Everyone in the team sees and can use this ${what}; the team's admins change it.`)
        : (orgHint ?? `Everyone in the workspace sees and can use this ${what}.`);
  return (
    <div>
      {label && <span className="block text-xs text-text-muted mb-1">{label}</span>}
      <Segmented
        aria-label={label ?? "Owner"}
        size={size}
        wrap
        value={segment}
        onChange={(v) => {
          if (v === "team") onChange(teamOwner(teamId ?? options[0].id) as T);
          else onChange(v as T);
        }}
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
          ...(offerTeam
            ? [
                {
                  value: "team" as const,
                  label: "Team",
                  icon: <Users className="w-3 h-3" />,
                  disabled: disabledReason ?? undefined,
                },
              ]
            : []),
          {
            value: "private",
            label: "Private",
            icon: <Lock className="w-3 h-3" />,
            disabled: disabledReason ?? undefined,
          },
        ]}
      />
      {segment === "team" && (
        <select
          aria-label="Team"
          value={teamId ?? ""}
          disabled={!!disabledReason || options.length <= 1}
          onChange={(e) => onChange(teamOwner(e.target.value) as T)}
          className={inputClass({ size: "sm", className: "mt-2 w-auto min-w-[12rem]" })}
        >
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <p className="text-[11px] text-text-muted/80 mt-1.5">{hint}</p>
    </div>
  );
}
