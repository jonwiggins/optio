"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Loader2, Building2, Users, Trash2, UserPlus, Shield, Eye, Edit3 } from "lucide-react";

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

  if (loading) {
    return (
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card text-center text-text-muted text-sm">
        No workspace selected
      </div>
    );
  }

  const isAdmin = role === "admin";

  return (
    <div className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!isAdmin}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Slug</label>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            disabled={!isAdmin}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary disabled:opacity-50"
            pattern="[a-z0-9-]+"
          />
          <p className="text-[10px] text-text-muted mt-1">
            URL-friendly identifier. Lowercase letters, numbers, and hyphens only.
          </p>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!isAdmin}
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary disabled:opacity-50 resize-none"
          />
        </div>
      </div>
      {isAdmin && (
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      )}
      {!isAdmin && (
        <p className="text-xs text-text-muted">
          Only workspace admins can edit workspace settings.
        </p>
      )}
    </div>
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

  if (loading) {
    return (
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

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

  return (
    <div className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
      <div className="space-y-2">
        {members.map((member) => (
          <div
            key={member.id}
            className="flex items-center gap-3 p-3 rounded-lg border border-border"
          >
            {member.avatarUrl ? (
              <img src={member.avatarUrl} alt="" className="w-8 h-8 rounded-full shrink-0" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4 text-primary" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{member.displayName}</p>
              <p className="text-[10px] text-text-muted truncate">{member.email}</p>
            </div>
            <div className="flex items-center gap-2">
              {roleIcon(member.role)}
              {isAdmin ? (
                <select
                  value={member.role}
                  onChange={(e) => handleRoleChange(member.userId, e.target.value)}
                  className="text-xs px-2 py-1 rounded border border-border bg-bg focus:outline-none focus:border-primary"
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
              ) : (
                <span className="text-xs text-text-muted capitalize">{member.role}</span>
              )}
              {isAdmin && members.length > 1 && (
                <button
                  onClick={() => handleRemove(member.userId, member.displayName)}
                  className="p-1 rounded hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                  title="Remove member"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {isAdmin && (
        <div className="pt-4 border-t border-border/50">
          <p className="text-xs font-medium text-text-muted mb-3 flex items-center gap-1.5">
            <UserPlus className="w-3.5 h-3.5" /> Add New Member
          </p>
          <form onSubmit={handleAddMember} className="flex flex-wrap gap-2">
            <div className="flex-1 min-w-[200px]">
              <input
                type="email"
                placeholder="user@example.com"
                value={addingEmail}
                onChange={(e) => setAddingEmail(e.target.value)}
                required
                className="w-full px-3 py-1.5 rounded-lg bg-bg border border-border text-xs focus:outline-none focus:border-primary"
              />
            </div>
            <select
              value={addingRole}
              onChange={(e) => setAddingRole(e.target.value)}
              className="text-xs px-2 py-1.5 rounded border border-border bg-bg focus:outline-none focus:border-primary"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              type="submit"
              disabled={isAdding || !addingEmail}
              className="px-4 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 flex items-center gap-2"
            >
              {isAdding ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" /> Adding...
                </>
              ) : (
                "Add Member"
              )}
            </button>
          </form>
          <p className="text-[10px] text-text-muted mt-2">
            The user must have signed in to Optio at least once to be found.
          </p>
        </div>
      )}
    </div>
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
    <div className="p-5 rounded-xl border border-error/30 bg-error/5 space-y-3">
      <div>
        <p className="text-sm font-medium text-error">Delete workspace</p>
        <p className="text-xs text-text-muted mt-1">
          Permanently delete this workspace and all its data. This action cannot be undone.
        </p>
      </div>
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="px-4 py-1.5 rounded-md bg-error text-white text-xs hover:bg-error/90 disabled:opacity-50"
      >
        {deleting ? "Deleting..." : "Delete workspace"}
      </button>
    </div>
  );
}

export default function WorkspaceSettingsPage() {
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      <div className="flex items-center gap-3">
        <Building2 className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">Workspace Settings</h1>
      </div>

      {/* Workspace Info */}
      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">General</h2>
        <WorkspaceInfo />
      </section>

      {/* Members */}
      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Members</h2>
        <MemberManagement />
      </section>

      {/* Danger Zone */}
      <section>
        <DangerZone />
      </section>
    </div>
  );
}
