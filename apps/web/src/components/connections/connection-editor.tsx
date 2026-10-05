"use client";

import { useEffect, useState } from "react";
import { Building2, Loader2, Lock, X, Zap } from "lucide-react";
import { toast } from "sonner";
import type { Connection } from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { ConnectionMark } from "@/components/connection-mark";
import {
  DefaultAssignmentsField,
  ProviderFields,
  Switch,
  assignmentRows,
  assignmentsFromRows,
  requiredMissing,
  type ConfigSchema,
  type ConfigValue,
  type DefaultAssignments,
} from "./provider-fields";

/**
 * The right-side sheet that edits one connection: its name, its fields (a
 * saved secret stays unless replaced), whether its shell env is exported,
 * and where it is connected by default. Owner is fixed once saved.
 */

export interface ConnectionEditorProps {
  connectionId: string;
  open: boolean;
  onClose: () => void;
  onSaved: (connection: Connection) => void;
  onDeleted?: (connectionId: string) => void;
}

/**
 * The config to PATCH: only keys the user touched. A blank value for a saved
 * secret is dropped (blank = keep); a blank non-secret clears the key (null).
 */
export function changedConfig(
  before: ConfigValue,
  after: ConfigValue,
  schema: ConfigSchema | null | undefined,
): ConfigValue {
  const out: ConfigValue = {};
  const props = schema?.properties ?? {};
  for (const [key, v] of Object.entries(after)) {
    const isSecret = props[key]?.format === "secret";
    const blank = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    if (isSecret) {
      if (!blank) out[key] = v;
      continue;
    }
    const wasBlank =
      before[key] === undefined ||
      before[key] === null ||
      (typeof before[key] === "string" && String(before[key]).trim() === "");
    if (blank && wasBlank) continue;
    if (!blank && before[key] === v) continue;
    out[key] = blank ? null : v;
  }
  return out;
}

export function ConnectionEditor({
  connectionId,
  open,
  onClose,
  onSaved,
  onDeleted,
}: ConnectionEditorProps) {
  const [conn, setConn] = useState<Connection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<ConfigValue>({});
  const [exportShellEnv, setExportShellEnv] = useState(true);
  const [assignments, setAssignments] = useState<DefaultAssignments>({
    allRepos: true,
    repoIds: [],
    agentTypes: [],
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setConn(null);
    setLoadError(null);
    api
      .getConnection(connectionId)
      .then(({ connection }) => {
        if (!live) return;
        setConn(connection);
        setName(connection.name);
        setConfig({ ...(connection.config ?? {}) });
        setExportShellEnv(connection.exportShellEnv);
        setAssignments(assignmentsFromRows(connection.assignments));
      })
      .catch((err) => {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [open, connectionId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const provider = conn?.provider ?? null;
  const schema = (provider?.configSchema ?? null) as ConfigSchema | null;
  const secretFields = conn?.secretFields ?? [];
  const hasShellEnv = !!provider?.shellEnv && Object.keys(provider.shellEnv).length > 0;
  const missing = conn ? requiredMissing(schema, config, secretFields) : [];
  const canSave = !!conn && name.trim().length > 0 && missing.length === 0 && !saving;
  const isPrivate = !!conn?.ownerUserId;

  const save = async () => {
    if (!conn || !canSave) return;
    setSaving(true);
    try {
      const { connection } = await api.updateConnection(conn.id, {
        name: name.trim(),
        config: changedConfig(conn.config ?? {}, config, schema),
        exportShellEnv,
        assignments: assignmentRows(assignments),
      });
      toast.success(`Saved ${connection.name}`);
      onSaved(connection);
      onClose();
    } catch (err) {
      toast.error("Couldn't save the connection", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!conn) return;
    setTesting(true);
    try {
      const { connection } = await api.testConnection(conn.id);
      setConn((c) =>
        c ? { ...c, status: connection.status, statusMessage: connection.statusMessage } : c,
      );
      if (connection.status === "healthy") {
        toast.success("Connection works", { description: connection.statusMessage ?? undefined });
      } else {
        toast.error("Test failed", { description: connection.statusMessage ?? "No details" });
      }
    } catch (err) {
      toast.error("Test failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!conn || !onDeleted) return;
    if (!window.confirm(`Delete ${conn.name}? Work using it loses it.`)) return;
    setDeleting(true);
    try {
      await api.deleteConnection(conn.id);
      toast.success(`Deleted ${conn.name}`);
      onDeleted(conn.id);
      onClose();
    } catch (err) {
      toast.error("Couldn't delete the connection", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="connection-editor"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={conn ? `Edit ${conn.name}` : "Edit connection"}
        className="fixed inset-y-0 right-0 w-full sm:w-[480px] bg-bg border-l border-border shadow-xl flex flex-col"
      >
        <div className="bg-bg-subtle flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <ConnectionMark icon={provider?.icon} kind="connection" size="lg" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold tracking-tight text-text-heading truncate">
                {conn?.name ?? "Connection"}
              </h2>
              <p className="text-xs text-text-muted truncate">{provider?.name ?? "Loading…"}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {loadError ? (
            <p className="text-sm text-error">Couldn't load the connection: {loadError}</p>
          ) : !conn ? (
            <p className="text-xs text-text-muted flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </p>
          ) : (
            <>
              <div>
                <span className="block text-xs text-text-muted mb-1">Owner</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
                    isPrivate ? "bg-primary/10 text-primary" : "bg-bg-hover text-text-muted",
                  )}
                  title="A connection's owner is fixed once it is saved"
                >
                  {isPrivate ? <Lock className="w-3 h-3" /> : <Building2 className="w-3 h-3" />}
                  {isPrivate ? "Private" : "Organization"}
                </span>
              </div>

              <div>
                <label htmlFor="edit-conn-name" className="block text-xs text-text-muted mb-1">
                  Name
                </label>
                <input
                  id="edit-conn-name"
                  type="text"
                  aria-label="Connection name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className={inputClass()}
                />
              </div>

              <ProviderFields
                schema={schema}
                value={config}
                onChange={setConfig}
                secretFields={secretFields}
                mode="edit"
                idPrefix={`edit-${conn.id}`}
              />

              {hasShellEnv && (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <label htmlFor="edit-conn-shell-env" className="text-sm text-text">
                      Also export to the agent's shell
                    </label>
                    <p className="text-[11px] text-text-muted/80">
                      {Object.keys(provider?.shellEnv ?? {}).join(", ")}
                    </p>
                  </div>
                  <Switch
                    id="edit-conn-shell-env"
                    checked={exportShellEnv}
                    onChange={setExportShellEnv}
                    label="Also export to the agent's shell"
                  />
                </div>
              )}

              {provider?.note && (
                <div className="rounded-lg border border-border bg-bg-subtle/60 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-text-muted mb-1">
                    What the agent is told
                  </p>
                  <p className="text-xs text-text-muted whitespace-pre-wrap">{provider.note}</p>
                </div>
              )}

              <DefaultAssignmentsField value={assignments} onChange={setAssignments} />

              {conn.statusMessage && (
                <p
                  className={cn(
                    "text-xs",
                    conn.status === "error" ? "text-error" : "text-text-muted",
                  )}
                >
                  Last test: {conn.statusMessage}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-border shrink-0">
          {onDeleted && conn && (
            <Button variant="danger" size="sm" onClick={remove} disabled={deleting}>
              {deleting && <Loader2 className="animate-spin" />}
              Delete
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {provider?.healthCheck && (
            <Button variant="secondary" onClick={test} disabled={!conn || testing}>
              {testing ? <Loader2 className="animate-spin" /> : <Zap />}
              Test
            </Button>
          )}
          <Button onClick={save} disabled={!canSave}>
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
