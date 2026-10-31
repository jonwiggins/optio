"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api-client";
import { Building2, ChevronDown, Plus, Check, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { GroupsCombobox } from "@/components/ui/groups-combobox";
import { inputClass } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";

interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/** A workspace the person's groups open that they aren't in yet. */
interface DiscoverableWorkspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: "member" | "viewer";
}

export function WorkspaceSwitcher({ returnToWork = false }: { returnToWork?: boolean } = {}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // Groups whose members may be in the new workspace, and the role they get.
  const [newGroups, setNewGroups] = useState<string[]>([]);
  const [newRole, setNewRole] = useState<"member" | "viewer">("member");
  const [busy, setBusy] = useState(false);
  const [discoverable, setDiscoverable] = useState<DiscoverableWorkspace[]>([]);
  // Who may create a workspace, and name its groups (a deployment admin;
  // GET /api/deployment-settings). Hidden until known, and if it can't be read.
  const [may, setMay] = useState({ create: false, groups: false });
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load workspaces and current workspace
    api
      .listWorkspaces()
      .then((res) => {
        setWorkspaces(res.workspaces);
        // Determine current workspace from localStorage or default
        const storedId = localStorage.getItem("optio_workspace_id");
        if (storedId && res.workspaces.some((w) => w.id === storedId)) {
          setCurrentId(storedId);
        } else if (res.workspaces.length > 0) {
          setCurrentId(res.workspaces[0].id);
          localStorage.setItem("optio_workspace_id", res.workspaces[0].id);
        }
      })
      .catch(() => {});
    // Workspaces the person's groups open (docs/teams.md); none without groups.
    api
      .listDiscoverableWorkspaces()
      .then((res) => setDiscoverable(res.workspaces))
      .catch(() => {});
    api
      .getDeploymentSettings()
      .then((res) => setMay({ create: res.mayCreateWorkspace, groups: res.canEdit }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      // The New workspace dialog lives outside the menu: clicks in it don't close it.
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const current = workspaces.find((w) => w.id === currentId);

  const handleSwitch = async (ws: WorkspaceSummary) => {
    try {
      await api.switchWorkspace(ws.id);
      localStorage.setItem("optio_workspace_id", ws.id);
      setCurrentId(ws.id);
      setOpen(false);
      // A session belongs to its workspace. Leave its detail view when
      // switching, and refresh all workspace-scoped state in either case.
      if (returnToWork) window.location.assign("/work");
      else window.location.reload();
    } catch {
      // best-effort
    }
  };

  const closeCreate = () => {
    setCreating(false);
    setNewName("");
    setNewGroups([]);
    setNewRole("member");
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const slug = newName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    setBusy(true);
    try {
      const res = await api.createWorkspace({
        name: newName.trim(),
        slug,
        ...(newGroups.length ? { accessGroups: newGroups, accessGroupsRole: newRole } : {}),
      });
      const newWs = {
        id: res.workspace.id,
        name: res.workspace.name,
        slug: res.workspace.slug,
        role: "admin",
      };
      setWorkspaces((prev) => [...prev, newWs]);
      closeCreate();
      await handleSwitch(newWs);
    } catch (err) {
      toast.error("Couldn't create the workspace", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async (ws: DiscoverableWorkspace) => {
    try {
      const { role } = await api.joinWorkspace(ws.id);
      setDiscoverable((prev) => prev.filter((d) => d.id !== ws.id));
      await handleSwitch({ id: ws.id, name: ws.name, slug: ws.slug, role });
    } catch (err) {
      toast.error(`Couldn't join ${ws.name}`, {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  if (workspaces.length === 0) return null;

  return (
    <div
      ref={menuRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setCreating(false);
          menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <button
        aria-label={`Switch workspace: ${current?.name ?? "Workspace"}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg border border-border/70 text-left hover:bg-bg-card hover:border-border-strong transition-colors"
      >
        <Building2 className="w-4 h-4 text-text-muted shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-xs font-medium text-text-heading truncate">
            {current?.name ?? "Workspace"}
          </span>
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-border bg-bg-card shadow-lg overflow-hidden z-[60]">
          <div className="px-3 py-1.5 text-[10px] text-text-muted font-medium uppercase tracking-wider">
            Workspaces
          </div>
          <div className="max-h-48 overflow-y-auto">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => handleSwitch(ws)}
                className="flex items-center gap-2 w-full px-3 py-2 text-xs hover:bg-bg-hover transition-colors text-left"
              >
                <Building2 className="w-3.5 h-3.5 text-text-muted shrink-0" />
                <span className="flex-1 truncate">{ws.name}</span>
                {ws.id === currentId && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                <span className="text-[10px] text-text-muted capitalize">{ws.role}</span>
              </button>
            ))}
          </div>
          {discoverable.length > 0 && (
            <div className="border-t border-border" data-testid="discoverable-workspaces">
              <div className="px-3 pt-1.5 pb-0.5 text-[10px] text-text-muted font-medium uppercase tracking-wider">
                Discoverable
              </div>
              <p className="px-3 pb-1 text-[10px] text-text-muted">Your groups give you access</p>
              <div className="max-h-40 overflow-y-auto">
                {discoverable.map((ws) => (
                  <div key={ws.id} className="flex items-center gap-2 w-full px-3 py-1.5 text-xs">
                    <Building2 className="w-3.5 h-3.5 text-text-muted shrink-0" />
                    <span className="flex-1 truncate" title={ws.description ?? undefined}>
                      {ws.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleJoin(ws)}
                      aria-label={`Join ${ws.name} as ${ws.role}`}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-text hover:bg-bg-hover"
                    >
                      <LogIn className="w-3 h-3" />
                      Join
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {may.create && (
            <div className="border-t border-border">
              <button
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
                className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text-muted hover:text-text hover:bg-bg-hover transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                New workspace
              </button>
            </div>
          )}
        </div>
      )}

      {creating && (
        <Dialog
          title="New workspace"
          description={
            may.groups
              ? "You'll be its admin. Groups you name here let their members in without an invite."
              : "You'll be its admin. A deployment admin can open it to directory groups later."
          }
          onClose={closeCreate}
          busy={busy}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={closeCreate} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={busy || !newName.trim()}>
                Create
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-text-muted">Name</span>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Platform team"
                className={inputClass({ size: "sm" })}
                autoFocus
              />
            </label>
            {may.groups && (
              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-text-muted">
                  Accessible to groups
                </span>
                <GroupsCombobox
                  label="Accessible to groups"
                  value={newGroups}
                  onChange={setNewGroups}
                />
                <p className="text-[11px] text-text-muted">
                  Members of these directory groups join it when they sign in, and see it under
                  Discoverable until they do. Leave empty for invite only.
                </p>
              </div>
            )}
            {may.groups && newGroups.length > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-text-muted">They join as</span>
                <Segmented
                  value={newRole}
                  onChange={setNewRole}
                  aria-label="Role for people joining by group"
                  options={[
                    { value: "member", label: "Member" },
                    { value: "viewer", label: "Viewer" },
                  ]}
                />
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
