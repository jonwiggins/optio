"use client";

import { useEffect, useState } from "react";
import { Loader2, MoreHorizontal, Zap } from "lucide-react";
import { toast } from "sonner";
import type { ConnectionStatus, WorkEnvironmentEntry } from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { ConnectionMark } from "@/components/connection-mark";
import { ManagedChip } from "@/components/ui/managed-chip";
import { entryOwnerScope, entrySubtext, type EntryOwnerScope } from "@/lib/connections";

/**
 * One row of the Connections page: a status dot, the logo tile, the name and
 * its subtext ("Private · credentials + shell env · AWS"), then **Test** for a
 * provider connection and a ⋯ menu (Edit / Enable / Disable / Delete). A bare
 * secret edits as "Replace value"; an MCP server edits inline. Someone else's
 * private row is greyed and offers only Delete, to an admin.
 */

export interface ConnectionRowProps {
  entry: WorkEnvironmentEntry;
  viewerId: string | null;
  isAdmin: boolean;
  /** Something about the row changed on the server: reload the catalog. */
  onChanged: () => void;
  /** Edit a provider connection (the page opens `ConnectionEditor`). */
  onEditConnection: (connectionId: string) => void;
}

/** Who may change / delete the row: the rule the Connections page has always used. */
export function rowPermissions(
  scope: EntryOwnerScope,
  isAdmin: boolean,
): { canChange: boolean; canDelete: boolean } {
  const canChange = scope === "organization" ? isAdmin : scope === "private";
  return { canChange, canDelete: canChange || (scope === "others" && isAdmin) };
}

/** The dot's colour: green when healthy, red when the last test failed, grey otherwise. */
export function statusDotClass(status: ConnectionStatus | undefined): string {
  if (status === "healthy") return "bg-success";
  if (status === "error") return "bg-error";
  return "bg-border-strong";
}

/** The `scope` `POST`/`DELETE /api/secrets` take for a catalog secret entry. */
export function secretApiScope(
  entry: Pick<WorkEnvironmentEntry, "scope" | "detail" | "ownerUserId">,
) {
  if (entry.scope === "repo" && entry.detail) return entry.detail;
  return entry.ownerUserId ? "user" : "global";
}

/** `KEY=VALUE` lines ⇄ an env record. */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return out;
}

export function envToLines(env: Record<string, string> | null | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

type Editing = null | "secret" | "mcp";

export function ConnectionRow({
  entry,
  viewerId,
  isAdmin,
  onChanged,
  onEditConnection,
}: ConnectionRowProps) {
  const scope = entryOwnerScope(entry, viewerId);
  const { canChange, canDelete } = rowPermissions(scope, isAdmin);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ status?: ConnectionStatus; message?: string | null }>({
    status: entry.status,
    message: null,
  });

  useEffect(() => {
    setStatus({ status: entry.status, message: null });
  }, [entry.status]);

  const others = scope === "others";
  const dotTitle =
    status.status === "error"
      ? (status.message ?? "The last test failed")
      : status.status === "healthy"
        ? "Healthy"
        : entry.kind === "connection"
          ? "Not tested yet"
          : undefined;

  const test = async () => {
    setTesting(true);
    try {
      const { connection } = await api.testConnection(entry.id);
      setStatus({ status: connection.status, message: connection.statusMessage ?? null });
      if (connection.status === "healthy") {
        toast.success(`${entry.name} works`, {
          description: connection.statusMessage ?? undefined,
        });
      } else {
        toast.error(`${entry.name}: test failed`, {
          description: connection.statusMessage ?? "No details",
        });
      }
    } catch (err) {
      toast.error(`${entry.name}: test failed`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      if (entry.kind === "connection") await api.updateConnection(entry.id, { enabled });
      else if (entry.kind === "mcpServer") await api.updateMcpServer(entry.id, { enabled });
      toast.success(`${enabled ? "Enabled" : "Disabled"} ${entry.name}`);
      onChanged();
    } catch (err) {
      toast.error(`Couldn't ${enabled ? "enable" : "disable"} ${entry.name}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const whose = others ? `${entry.ownerName ?? "their"}'s private ` : "";
    if (!window.confirm(`Delete ${whose}${entry.name}? Work using it loses it.`)) return;
    setBusy(true);
    try {
      if (entry.kind === "connection") await api.deleteConnection(entry.id);
      else if (entry.kind === "mcpServer") await api.deleteMcpServer(entry.id);
      else {
        await api.deleteSecret(
          entry.name,
          secretApiScope(entry),
          others ? (entry.ownerUserId ?? undefined) : undefined,
        );
      }
      toast.success(`Deleted ${entry.name}`);
      onChanged();
    } catch (err) {
      toast.error(`Couldn't delete ${entry.name}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const edit = () => {
    setMenuOpen(false);
    if (entry.kind === "connection") onEditConnection(entry.id);
    else if (entry.kind === "secret") setEditing("secret");
    else setEditing("mcp");
  };

  const canToggle = entry.kind !== "secret" && canChange;

  return (
    <div
      data-testid="connection-row"
      data-kind={entry.kind}
      className={cn(
        "group bg-bg-card/40 hover:bg-bg-hover/60 transition-colors",
        !entry.enabled && "opacity-60",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          aria-hidden="true"
          title={dotTitle}
          className={cn("w-2 h-2 rounded-full shrink-0", statusDotClass(status.status))}
        />
        <ConnectionMark
          icon={entry.icon}
          kind={entry.kind}
          size="md"
          className={cn(others && "opacity-60")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={cn(
                "text-sm font-medium truncate",
                others ? "text-text-muted" : "text-text-heading",
                entry.kind === "secret" && "font-mono",
              )}
            >
              {entry.name}
            </span>
            {!entry.enabled && (
              <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-muted shrink-0">
                disabled
              </span>
            )}
            <ManagedChip managedBy={entry.managedBy} />
          </div>
          <p className="text-[11px] text-text-muted truncate" title={entry.detail ?? undefined}>
            {entrySubtext(entry, viewerId)}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {entry.kind === "connection" && !others && (
            <Button variant="ghost" size="sm" onClick={test} disabled={testing || busy}>
              {testing ? <Loader2 className="animate-spin" /> : <Zap />}
              Test
            </Button>
          )}
          {(canChange || canDelete) && (
            <div className="relative">
              <button
                type="button"
                aria-label={`Actions for ${entry.name}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
                disabled={busy}
                className="p-1.5 rounded-md text-text-muted hover:text-text hover:bg-bg-hover disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <MoreHorizontal className="w-4 h-4" />
                )}
              </button>
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <div
                    role="menu"
                    aria-label={`Actions for ${entry.name}`}
                    className="absolute right-0 top-full mt-1 z-20 min-w-[9rem] rounded-lg border border-border bg-bg shadow-lg py-1 text-sm"
                  >
                    {canChange && (
                      <MenuItem onClick={edit}>
                        {entry.kind === "secret" ? "Replace value" : "Edit"}
                      </MenuItem>
                    )}
                    {canToggle && (
                      <MenuItem
                        onClick={() => {
                          setMenuOpen(false);
                          void setEnabled(!entry.enabled);
                        }}
                      >
                        {entry.enabled ? "Disable" : "Enable"}
                      </MenuItem>
                    )}
                    {canDelete && (
                      <MenuItem
                        tone="danger"
                        onClick={() => {
                          setMenuOpen(false);
                          void remove();
                        }}
                      >
                        Delete
                      </MenuItem>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {editing === "secret" && (
        <ReplaceSecretForm
          entry={entry}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
      {editing === "mcp" && (
        <McpServerForm
          entry={entry}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  tone = "default",
  children,
}: {
  onClick: () => void;
  tone?: "default" | "danger";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "block w-full text-left px-3 py-1.5 hover:bg-bg-hover",
        tone === "danger" ? "text-error" : "text-text",
      )}
    >
      {children}
    </button>
  );
}

// ── Inline editors ──────────────────────────────────────────────────────────

/** A bare secret's one edit: a new value, saved under the same name and scope. */
function ReplaceSecretForm({
  entry,
  onClose,
  onSaved,
}: {
  entry: WorkEnvironmentEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value) return;
    setSaving(true);
    try {
      await api.createSecret({ name: entry.name, value, scope: secretApiScope(entry) });
      toast.success(`Replaced ${entry.name}`);
      onSaved();
    } catch (err) {
      toast.error(`Couldn't replace ${entry.name}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      onSubmit={save}
      className="flex flex-wrap items-end gap-2 px-4 pb-3 pl-[4.25rem]"
      aria-label={`Replace ${entry.name}`}
    >
      <div className="flex-1 min-w-[12rem]">
        <label htmlFor={`replace-${entry.id}`} className="block text-xs text-text-muted mb-1">
          New value
        </label>
        <input
          id={`replace-${entry.id}`}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          autoFocus
          className={inputClass({ size: "sm", className: "font-mono" })}
        />
      </div>
      <Button type="submit" size="sm" disabled={!value || saving}>
        {saving && <Loader2 className="animate-spin" />}
        Save
      </Button>
      <Button variant="secondary" size="sm" onClick={onClose}>
        Cancel
      </Button>
    </form>
  );
}

/** A hand-written MCP server's fields: command, args, env, install command. */
function McpServerForm({
  entry,
  onClose,
  onSaved,
}: {
  entry: WorkEnvironmentEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [install, setInstall] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .getMcpServer(entry.id)
      .then(({ server }) => {
        if (!live) return;
        setCommand(server.command ?? "");
        setArgs((server.args ?? []).join(" "));
        setEnv(envToLines(server.env));
        setInstall(server.installCommand ?? "");
        setLoaded(true);
      })
      .catch((err) => {
        toast.error(`Couldn't load ${entry.name}`, {
          description: err instanceof Error ? err.message : String(err),
        });
        onClose();
      });
    return () => {
      live = false;
    };
  }, [entry.id, entry.name, onClose]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!command.trim()) return;
    setSaving(true);
    try {
      await api.updateMcpServer(entry.id, {
        command: command.trim(),
        args: args.split(/\s+/).filter(Boolean),
        env: env.trim() ? parseEnvLines(env) : null,
        installCommand: install.trim() || null,
      });
      toast.success(`Saved ${entry.name}`);
      onSaved();
    } catch (err) {
      toast.error(`Couldn't save ${entry.name}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <p className="px-4 pb-3 pl-[4.25rem] text-xs text-text-muted flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
      </p>
    );
  }

  const field = (label: string, id: string) => (
    <label htmlFor={id} className="block text-xs text-text-muted mb-1">
      {label}
    </label>
  );

  return (
    <form
      onSubmit={save}
      className="px-4 pb-3 pl-[4.25rem] space-y-3"
      aria-label={`Edit ${entry.name}`}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          {field("Command", `mcp-${entry.id}-command`)}
          <input
            id={`mcp-${entry.id}-command`}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            required
            className={inputClass({ size: "sm", className: "font-mono" })}
          />
        </div>
        <div>
          {field("Arguments", `mcp-${entry.id}-args`)}
          <input
            id={`mcp-${entry.id}-args`}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="-y @scope/server"
            className={inputClass({ size: "sm", className: "font-mono" })}
          />
        </div>
        <div>
          {field("Environment (KEY=VALUE, one per line)", `mcp-${entry.id}-env`)}
          <textarea
            id={`mcp-${entry.id}-env`}
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            rows={3}
            placeholder={"API_URL=https://…\nTOKEN=${{MY_SECRET}}"}
            className={inputClass({ size: "sm", className: "font-mono min-h-[64px]" })}
          />
        </div>
        <div>
          {field("Install command", `mcp-${entry.id}-install`)}
          <input
            id={`mcp-${entry.id}-install`}
            value={install}
            onChange={(e) => setInstall(e.target.value)}
            placeholder="npm install -g @scope/server"
            className={inputClass({ size: "sm", className: "font-mono" })}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!command.trim() || saving}>
          {saving && <Loader2 className="animate-spin" />}
          Save
        </Button>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
