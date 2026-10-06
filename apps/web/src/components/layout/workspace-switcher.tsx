"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api-client";
import { Building2, ChevronDown, Plus, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
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
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
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
      // Reload page to refresh all data for the new workspace
      window.location.reload();
    } catch {
      // best-effort
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const slug = newName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    try {
      const res = await api.createWorkspace({ name: newName.trim(), slug });
      const newWs = {
        id: res.workspace.id,
        name: res.workspace.name,
        slug: res.workspace.slug,
        role: "admin",
      };
      setWorkspaces((prev) => [...prev, newWs]);
      setNewName("");
      setCreating(false);
      await handleSwitch(newWs);
    } catch {
      // best-effort
    }
  };

  if (workspaces.length === 0) return null;

  return (
    <div
      ref={menuRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
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
        className="flex items-center gap-2.5 w-full px-3 py-2.5 rounded-xl border border-border/70 bg-bg-card/60 text-left hover:bg-bg-card hover:border-border-strong transition-colors"
      >
        <Building2 className="w-4 h-4 text-text-muted shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-[10px] text-text-muted">Workspace</span>
          <span className="block text-xs font-medium text-text-heading truncate">
            {current?.name ?? "Workspace"}
          </span>
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-border bg-bg-card shadow-lg overflow-hidden z-50">
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
          <div className="border-t border-border">
            {creating ? (
              <div className="p-2">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  placeholder="Workspace name"
                  className={inputClass({ size: "sm" })}
                  autoFocus
                />
                <div className="flex gap-1 mt-1.5">
                  <Button size="sm" onClick={handleCreate} className="flex-1">
                    Create
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setCreating(false);
                      setNewName("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text-muted hover:text-text hover:bg-bg-hover transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                New workspace
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
