"use client";

import { useState, useEffect } from "react";
import { FORM_WIDTH } from "@/components/ui/page";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Loader2, Building2, Users, Trash2, UserPlus, Shield, Eye, Edit3, X } from "lucide-react";
import { addDomains } from "@/lib/auto-join-domains";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import {
  BTN_PRIMARY,
  BTN_ROW_DANGER,
  BTN_SECONDARY,
  CardFooter,
  Field,
  INPUT,
  SkeletonCard,
} from "@/components/settings/settings-ui";

const ROLE_OPTIONS = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
];

interface WorkspaceDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Member {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  createdAt: string;
}

/**
 * Sign-in auto-join (people whose verified email is on one of these domains
 * join on sign-in, with this role) and the pod-secrets policy. Each change
 * saves on its own.
 */
function AccessSettings() {
  const [wsId, setWsId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [joinRole, setJoinRole] = useState<"member" | "viewer">("member");
  const [restrict, setRestrict] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const id = localStorage.getItem("optio_workspace_id");
    if (!id) {
      setLoading(false);
      return;
    }
    setWsId(id);
    api
      .getWorkspace(id)
      .then((res) => {
        setRole(res.role);
        setDomains(res.workspace.autoJoinDomains ?? []);
        setJoinRole(res.workspace.autoJoinRole === "viewer" ? "viewer" : "member");
        setRestrict(!!res.workspace.restrictPodSecrets);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const isAdmin = role === "admin";

  const save = async (
    patch: { autoJoinDomains?: string[]; autoJoinRole?: string; restrictPodSecrets?: boolean },
    revert: () => void,
  ) => {
    if (!wsId) return;
    setSaving(true);
    try {
      await api.updateWorkspace(wsId, patch);
      toast.success("Saved");
    } catch (err) {
      revert();
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const setDomainList = (next: string[]) => {
    const prev = domains;
    setDomains(next);
    save({ autoJoinDomains: next }, () => setDomains(prev));
  };

  const addFromInput = () => {
    const { domains: next, invalid } = addDomains(domains, input);
    if (invalid.length) toast.error(`Not a domain: ${invalid.join(", ")}`);
    setInput(invalid.join(" "));
    if (next.length !== domains.length) setDomainList(next);
  };

  const label = "Access";
  const hint = "Who joins on sign-in, and which secrets pods get";
  if (loading) return <SkeletonCard label={label} hint={hint} rows={2} />;
  if (!wsId) return null;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={
        domains.length
          ? `${domains.length === 1 ? domains[0] : `${domains.length} domains`} → ${joinRole}`
          : "invite only"
      }
      bodyClassName="p-4 space-y-4"
    >
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium">Sign-in</p>
          <p className="text-xs text-text-muted mt-0.5">
            People who sign in with a verified email on these domains join this workspace.
          </p>
        </div>
        {(domains.length > 0 || !isAdmin) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {domains.map((d) => (
              <span
                key={d}
                className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md bg-bg border border-border text-xs font-mono"
              >
                {d}
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setDomainList(domains.filter((x) => x !== d))}
                    disabled={saving}
                    className="p-0.5 rounded text-text-muted hover:text-text"
                    aria-label={`Remove ${d}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </span>
            ))}
            {domains.length === 0 && !isAdmin && (
              <span className="text-xs text-text-muted">None — people join by invite only.</span>
            )}
          </div>
        )}
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addFromInput();
                }
              }}
              placeholder="acme.com"
              className={`${INPUT} flex-1 min-w-[12rem] w-auto font-mono`}
            />
            <button
              type="button"
              onClick={addFromInput}
              disabled={saving || !input.trim()}
              className={BTN_SECONDARY}
            >
              Add domain
            </button>
          </div>
        )}
        <div className="flex items-center gap-3 text-sm">
          <span className="text-xs font-medium text-text-muted">They join as</span>
          <Segmented
            value={joinRole}
            onChange={(next) => {
              if (!isAdmin || saving || next === joinRole) return;
              const prev = joinRole;
              setJoinRole(next);
              save({ autoJoinRole: next }, () => setJoinRole(prev));
            }}
            aria-label="Auto-join role"
            options={[
              {
                value: "member",
                label: "Member",
                disabled: !isAdmin ? "Only admins can change this" : undefined,
              },
              {
                value: "viewer",
                label: "Viewer",
                disabled: !isAdmin ? "Only admins can change this" : undefined,
              },
            ]}
          />
        </div>
      </div>

      <div className="pt-4 border-t border-border">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={restrict}
            disabled={!isAdmin || saving}
            onChange={(e) => {
              const prev = restrict;
              setRestrict(e.target.checked);
              save({ restrictPodSecrets: e.target.checked }, () => setRestrict(prev));
            }}
            className="w-4 h-4 rounded mt-0.5"
          />
          <span>
            <span className="block text-sm font-medium">Pods get only the secrets work picks</span>
            <span className="block text-xs text-text-muted mt-0.5">
              Off: work that picks no secrets still gets every organization secret in repo pods.
            </span>
          </span>
        </label>
      </div>
    </SectionCard>
  );
}

function WorkspaceInfo() {
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    const wsId = localStorage.getItem("optio_workspace_id");
    if (!wsId) {
      setLoading(false);
      return;
    }
    api
      .getWorkspace(wsId)
      .then((res) => {
        setWorkspace(res.workspace);
        setRole(res.role);
        setName(res.workspace.name);
        setSlug(res.workspace.slug);
        setDescription(res.workspace.description ?? "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!workspace) return;
    setSaving(true);
    try {
      const res = await api.updateWorkspace(workspace.id, {
        name,
        slug,
        description: description || null,
      });
      setWorkspace(res.workspace);
      toast.success("Workspace updated");
    } catch (err) {
      toast.error("Failed to update workspace", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const label = "General";
  const hint = "Name, slug, and description";
  if (loading) return <SkeletonCard label={label} hint={hint} rows={3} />;

  if (!workspace) {
    return (
      <EmptyState
        size="panel"
        icon={Building2}
        title="No workspace selected"
        description="Pick a workspace from the sidebar to edit its settings."
      />
    );
  }

  const isAdmin = role === "admin";

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={`${workspace.name} · ${workspace.slug}`}
      bodyClassName="p-4 space-y-4"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!isAdmin}
            className={INPUT}
          />
        </Field>
        <Field
          label="Slug"
          help="URL-friendly identifier. Lowercase letters, numbers, and hyphens only."
        >
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!isAdmin}
            className={`${INPUT} font-mono`}
            pattern="[a-z0-9-]+"
          />
        </Field>
      </div>
      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!isAdmin}
          rows={2}
          className={`${INPUT} resize-none`}
        />
      </Field>
      <CardFooter note={isAdmin ? undefined : "Only workspace admins can edit workspace settings."}>
        {isAdmin && (
          <button onClick={handleSave} disabled={saving} className={BTN_PRIMARY}>
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {saving ? "Saving..." : "Save"}
          </button>
        )}
      </CardFooter>
    </SectionCard>
  );
}

function MemberManagement() {
  const [members, setMembers] = useState<Member[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [addingEmail, setAddingEmail] = useState("");
  const [addingRole, setAddingRole] = useState("member");
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    const wsId = localStorage.getItem("optio_workspace_id");
    if (!wsId) {
      setLoading(false);
      return;
    }
    Promise.all([api.listWorkspaceMembers(wsId), api.getWorkspace(wsId)])
      .then(([membersRes, wsRes]) => {
        setMembers(membersRes.members);
        setRole(wsRes.role);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const isAdmin = role === "admin";
  const wsId = typeof window !== "undefined" ? localStorage.getItem("optio_workspace_id") : null;

  const handleRoleChange = async (userId: string, newRole: string) => {
    if (!wsId) return;
    try {
      await api.updateWorkspaceMemberRole(wsId, userId, newRole);
      setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, role: newRole } : m)));
      toast.success("Role updated");
    } catch (err) {
      toast.error("Failed to update role", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleRemove = async (userId: string, displayName: string) => {
    if (!wsId) return;
    if (!confirm(`Remove ${displayName} from this workspace?`)) return;
    try {
      await api.removeWorkspaceMember(wsId, userId);
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
      toast.success("Member removed");
    } catch (err) {
      toast.error("Failed to remove member", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wsId || !addingEmail || isAdding) return;

    setIsAdding(true);
    try {
      // Look the user up by email, then add them. The duplicate-member check
      // is enforced server-side (409 from POST /members) so a stale local
      // `members` list can't accidentally re-add someone with a new role.
      const { user } = await api.lookupUserByEmail(addingEmail);
      await api.addWorkspaceMember(wsId, user.id, addingRole);

      const { members: updatedMembers } = await api.listWorkspaceMembers(wsId);
      setMembers(updatedMembers);
      setAddingEmail("");
      toast.success(`${user.displayName} added to workspace`);
    } catch (err) {
      toast.error("Failed to add member", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsAdding(false);
    }
  };

  const label = "Members";
  const hint = "Who's in this workspace, and what they can do";
  if (loading) return <SkeletonCard label={label} hint={hint} rows={3} />;
  if (!wsId) return null;

  const roleIcon = (r: string) => {
    switch (r) {
      case "admin":
        return <Shield className="w-3.5 h-3.5 text-primary" />;
      case "member":
        return <Edit3 className="w-3.5 h-3.5 text-text-muted" />;
      case "viewer":
        return <Eye className="w-3.5 h-3.5 text-text-muted" />;
      default:
        return null;
    }
  };

  const admins = members.filter((m) => m.role === "admin").length;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={`${members.length} member${members.length === 1 ? "" : "s"} · ${admins} admin${admins === 1 ? "" : "s"}`}
      summaryIcon={<Users className="w-3 h-3" />}
      bodyClassName="p-4 space-y-4"
    >
      {members.length === 0 ? (
        <EmptyState size="panel" icon={Users} title="No members" />
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border bg-bg">
          {members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 px-3 py-2.5">
              {member.avatarUrl ? (
                <img src={member.avatarUrl} alt="" className="w-8 h-8 rounded-full shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                  <Users className="w-4 h-4 text-primary" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{member.displayName}</p>
                <p className="text-[11px] text-text-muted truncate">{member.email}</p>
              </div>
              <div className="flex items-center gap-2">
                {isAdmin ? (
                  <Segmented
                    value={member.role}
                    onChange={(next) => {
                      if (next !== member.role) handleRoleChange(member.userId, next);
                    }}
                    aria-label={`Role for ${member.displayName}`}
                    options={ROLE_OPTIONS}
                  />
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-text-muted capitalize">
                    {roleIcon(member.role)}
                    {member.role}
                  </span>
                )}
                {isAdmin && members.length > 1 && (
                  <button
                    onClick={() => handleRemove(member.userId, member.displayName)}
                    className={BTN_ROW_DANGER}
                    title="Remove member"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {isAdmin && (
        <div className="pt-4 border-t border-border space-y-2">
          <p className="text-xs font-medium text-text-muted flex items-center gap-1.5">
            <UserPlus className="w-3.5 h-3.5" /> Add New Member
          </p>
          <form onSubmit={handleAddMember} className="flex flex-wrap items-center gap-2">
            <input
              type="email"
              placeholder="user@example.com"
              value={addingEmail}
              onChange={(e) => setAddingEmail(e.target.value)}
              required
              className={`${INPUT} flex-1 min-w-[200px] w-auto`}
            />
            <Segmented
              value={addingRole}
              onChange={setAddingRole}
              aria-label="Role for the new member"
              options={[ROLE_OPTIONS[1], ROLE_OPTIONS[0], ROLE_OPTIONS[2]]}
            />
            <button type="submit" disabled={isAdding || !addingEmail} className={BTN_PRIMARY}>
              {isAdding ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Adding...
                </>
              ) : (
                "Add Member"
              )}
            </button>
          </form>
          <p className="text-[11px] text-text-muted/80">
            The user must have signed in to Optio at least once to be found.
          </p>
        </div>
      )}
    </SectionCard>
  );
}

function DangerZone() {
  const [role, setRole] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const wsId = localStorage.getItem("optio_workspace_id");
    if (!wsId) return;
    api
      .getWorkspace(wsId)
      .then((res) => setRole(res.role))
      .catch(() => {});
  }, []);

  const handleDelete = async () => {
    const wsId = localStorage.getItem("optio_workspace_id");
    if (!wsId) return;
    if (!confirm("Are you sure you want to delete this workspace? This action cannot be undone.")) {
      return;
    }
    setDeleting(true);
    try {
      await api.deleteWorkspace(wsId);
      localStorage.removeItem("optio_workspace_id");
      toast.success("Workspace deleted");
      window.location.href = "/";
    } catch (err) {
      toast.error("Failed to delete workspace", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setDeleting(false);
    }
  };

  if (role !== "admin") return null;

  return (
    <section className="rounded-xl border border-error/30 bg-error/5 overflow-hidden">
      <header className="flex items-baseline gap-2 px-4 py-2.5 border-b border-error/20 bg-error/5">
        <h2 className="text-sm font-semibold tracking-tight text-error">Danger zone</h2>
        <span className="text-xs text-text-muted truncate">Can&apos;t be undone</span>
      </header>
      <div className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Delete workspace</p>
          <p className="text-xs text-text-muted mt-0.5">
            Permanently delete this workspace and all its data. This action cannot be undone.
          </p>
        </div>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-error text-white text-sm font-medium hover:bg-error/90 transition-colors disabled:opacity-50"
        >
          {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {deleting ? "Deleting..." : "Delete workspace"}
        </button>
      </div>
    </section>
  );
}

export default function WorkspaceSettingsPage() {
  return (
    <div className="page-column py-6">
      <PageHeader
        icon={Building2}
        title="Workspace Settings"
        description="This workspace's name, who can join it, and what each member can do."
      />
      <div className={`${FORM_WIDTH} space-y-4`}>
        <WorkspaceInfo />
        <AccessSettings />
        <MemberManagement />
        <div className="pt-4">
          <DangerZone />
        </div>
      </div>
    </div>
  );
}
