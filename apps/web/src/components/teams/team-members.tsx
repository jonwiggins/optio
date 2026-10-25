"use client";

import { useState } from "react";
import { Check, Loader2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import type { TeamDetail, TeamMember, TeamRole } from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn, formatRelativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { Panel, PanelEmpty } from "@/components/ui/panel";

/**
 * A team's people: the members (role chips; **Make admin** / **Remove** for
 * those who manage the team), the requests waiting (**Approve** / **Deny**),
 * and the form that adds someone by email. Every change comes back as the
 * whole team (`onChanged`), the way the API answers.
 */

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Avatar({ member }: { member: TeamMember }) {
  if (member.avatarUrl) {
    return <img src={member.avatarUrl} alt="" className="w-7 h-7 rounded-full shrink-0" />;
  }
  const initial = (member.displayName || member.email || "?").trim()[0]?.toUpperCase() ?? "?";
  return (
    <span className="grid place-items-center w-7 h-7 rounded-full bg-bg-hover text-xs font-medium text-text-muted shrink-0">
      {initial}
    </span>
  );
}

function RoleChip({ role }: { role: TeamRole }) {
  return (
    <span
      className={cn(
        "shrink-0 px-1.5 py-0.5 text-[10px] rounded font-medium",
        role === "admin" ? "bg-primary/10 text-primary" : "bg-bg-hover text-text-muted",
      )}
    >
      {role === "admin" ? "Admin" : "Member"}
    </span>
  );
}

function Who({ member, viewerId }: { member: TeamMember; viewerId: string | null }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-text-heading truncate">
          {member.displayName || member.email}
          {viewerId === member.userId && (
            <span className="text-text-muted font-normal"> (you)</span>
          )}
        </span>
        {member.status === "active" && <RoleChip role={member.role} />}
        {member.source === "sso" && (
          <span
            className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-bg-hover text-text-muted"
            title="Joined through an identity-provider group; leaves when the group no longer matches"
          >
            SSO
          </span>
        )}
      </div>
      <p className="text-[11px] text-text-muted truncate">{member.email}</p>
    </div>
  );
}

export function MembersSection({
  team,
  viewerId,
  onChanged,
}: {
  team: TeamDetail;
  viewerId: string | null;
  onChanged: (team: TeamDetail) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const members = team.members.filter((m) => m.status === "active");

  const setRole = async (m: TeamMember, role: TeamRole) => {
    setBusy(m.userId);
    try {
      const { team: next } = await api.setTeamMemberRole(team.id, m.userId, role);
      onChanged(next);
      toast.success(
        `${m.displayName || m.email} is now ${role === "admin" ? "an admin" : "a member"}`,
      );
    } catch (err) {
      toast.error("Couldn't change the role", { description: describeError(err) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (m: TeamMember) => {
    const who = viewerId === m.userId ? "yourself" : m.displayName || m.email;
    if (!confirm(`Remove ${who} from ${team.name}?`)) return;
    setBusy(m.userId);
    try {
      const { team: next } = await api.removeTeamMember(team.id, m.userId);
      onChanged(next);
      toast.success(`Removed ${m.displayName || m.email}`);
    } catch (err) {
      toast.error("Couldn't remove them", { description: describeError(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title={`Members · ${members.length}`}
      actions={
        team.canManage ? (
          <span className="text-text-muted">Admins run the team; members use what it owns</span>
        ) : undefined
      }
    >
      {members.length === 0 ? (
        <PanelEmpty>Nobody yet.</PanelEmpty>
      ) : (
        <ul className="divide-y divide-border/60">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 px-4 py-3">
              <Avatar member={m} />
              <Who member={m} viewerId={viewerId} />
              {team.canManage && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === m.userId}
                    onClick={() => setRole(m, m.role === "admin" ? "member" : "admin")}
                  >
                    {m.role === "admin" ? "Make member" : "Make admin"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === m.userId}
                    onClick={() => remove(m)}
                    title="Remove from the team"
                  >
                    {busy === m.userId ? <Loader2 className="animate-spin" /> : <X />}
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The people waiting to be let in (shown to those who manage the team). */
export function RequestsSection({
  team,
  onChanged,
}: {
  team: TeamDetail;
  onChanged: (team: TeamDetail) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const requests = team.members.filter((m) => m.status === "requested");
  if (!team.canManage || requests.length === 0) return null;

  const decide = async (m: TeamMember, decision: "approve" | "deny") => {
    setBusy(m.userId);
    try {
      const { team: next } = await api.decideTeamRequest(team.id, m.userId, decision);
      onChanged(next);
      toast.success(
        decision === "approve"
          ? `${m.displayName || m.email} is in`
          : `Denied ${m.displayName || m.email}`,
      );
    } catch (err) {
      toast.error("Couldn't decide the request", { description: describeError(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title={`Requests · ${requests.length}`}>
      <ul className="divide-y divide-border/60">
        {requests.map((m) => (
          <li key={m.userId} className="flex items-center gap-3 px-4 py-3">
            <Avatar member={m} />
            <Who member={m} viewerId={null} />
            <span className="text-[11px] text-text-muted shrink-0 hidden sm:inline">
              asked {formatRelativeTime(m.createdAt)}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button size="sm" disabled={busy === m.userId} onClick={() => decide(m, "approve")}>
                <Check />
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy === m.userId}
                onClick={() => decide(m, "deny")}
              >
                <X />
                Deny
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Add someone who has signed in to Optio, by email. */
export function AddMemberForm({
  team,
  onChanged,
}: {
  team: TeamDetail;
  onChanged: (team: TeamDetail) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const [saving, setSaving] = useState(false);
  const canSave = /\S+@\S+\.\S+/.test(email.trim()) && !saving;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    try {
      const { team: next } = await api.addTeamMember(team.id, { email: email.trim(), role });
      onChanged(next);
      toast.success(`Added ${email.trim()}`);
      setEmail("");
      setRole("member");
    } catch (err) {
      toast.error("Couldn't add them", { description: describeError(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={add}
      aria-label="Add member"
      className="flex flex-wrap items-end gap-2 px-4 py-3 border-t border-border/60 bg-bg-card/40"
    >
      <div className="flex-1 min-w-[14rem]">
        <label htmlFor={`add-member-${team.id}`} className="block text-xs text-text-muted mb-1">
          Add by email
        </label>
        <input
          id={`add-member-${team.id}`}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="sam@example.com"
          autoComplete="off"
          className={inputClass({ size: "sm" })}
        />
      </div>
      <div>
        <label
          htmlFor={`add-member-role-${team.id}`}
          className="block text-xs text-text-muted mb-1"
        >
          As
        </label>
        <select
          id={`add-member-role-${team.id}`}
          value={role}
          onChange={(e) => setRole(e.target.value as TeamRole)}
          className={inputClass({ size: "sm", className: "w-auto" })}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <Button size="sm" type="submit" disabled={!canSave}>
        {saving ? <Loader2 className="animate-spin" /> : <UserPlus />}
        Add
      </Button>
      <p className="basis-full text-[11px] text-text-muted/80">
        They need to have signed in to Optio once.
      </p>
    </form>
  );
}
