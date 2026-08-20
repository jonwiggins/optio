"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Layers,
  Loader2,
  Play,
  Plus,
  Ticket,
  Trash2,
  Webhook,
} from "lucide-react";

const TICKET_SOURCES = ["github", "gitlab", "linear", "jira", "notion"] as const;
type TriggerType = "schedule" | "webhook" | "ticket";

function triggerSummary(trigger: any): string {
  const config = (trigger.config ?? {}) as Record<string, unknown>;
  switch (trigger.type) {
    case "schedule":
      return String(config.cronExpression ?? "");
    case "webhook":
      return `/api/hooks/${String(config.path ?? "")}`;
    case "ticket": {
      const labels = Array.isArray(config.labels) ? (config.labels as string[]) : [];
      return `${String(config.source ?? "any source")}${labels.length ? ` · ${labels.join(", ")}` : ""}`;
    }
    default:
      return "";
  }
}

const TRIGGER_ICONS: Record<string, any> = {
  schedule: Clock,
  webhook: Webhook,
  ticket: Ticket,
  manual: Play,
};

/**
 * Power-user surface at the bottom of /local: reusable terminal specs
 * (blueprints) plus the schedule / webhook / ticket triggers that spawn them.
 */
export function BlueprintsSection({ hosts }: { hosts: any[] }) {
  const [open, setOpen] = useState(false);
  const [blueprints, setBlueprints] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const refetch = () =>
    api
      .listLocalBlueprints()
      .then((res) => setBlueprints(res.blueprints))
      .catch(() => {});

  useEffect(() => {
    if (!open || loaded) return;
    refetch().then(() => setLoaded(true));
  }, [open, loaded]);

  const handleDelete = async (bp: any) => {
    if (!confirm(`Delete blueprint "${bp.name}" and its triggers?`)) return;
    try {
      await api.deleteLocalBlueprint(bp.id);
      setBlueprints((prev) => prev.filter((b) => b.id !== bp.id));
      toast.success("Blueprint deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete blueprint");
    }
  };

  const handleToggle = async (bp: any) => {
    try {
      const res = await api.updateLocalBlueprint(bp.id, { enabled: !bp.enabled });
      setBlueprints((prev) => prev.map((b) => (b.id === bp.id ? res.blueprint : b)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update blueprint");
    }
  };

  const handleSpawn = async (bp: any) => {
    try {
      const res = await api.spawnLocalBlueprint(bp.id);
      toast.success(`Spawned "${res.terminal.title}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to spawn");
    }
  };

  return (
    <section className="mt-8">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm font-medium text-text-muted hover:text-text transition-colors"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Layers className="w-4 h-4" />
        Blueprints
        {loaded && blueprints.length > 0 && (
          <span className="text-xs text-text-muted/60">({blueprints.length})</span>
        )}
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          {!loaded ? (
            <div className="flex items-center gap-2 py-4 text-text-muted text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading blueprints...
            </div>
          ) : blueprints.length === 0 && !showForm ? (
            <p className="text-xs text-text-muted py-2">
              No blueprints yet. A blueprint is a reusable terminal spec — wire schedule, webhook,
              or ticket triggers to it to spawn terminals automatically.
            </p>
          ) : (
            blueprints.map((bp) => (
              <BlueprintRow
                key={bp.id}
                blueprint={bp}
                onDelete={() => handleDelete(bp)}
                onToggle={() => handleToggle(bp)}
                onSpawn={() => handleSpawn(bp)}
              />
            ))
          )}

          {showForm ? (
            <NewBlueprintForm
              hosts={hosts}
              onCancel={() => setShowForm(false)}
              onCreated={(bp) => {
                setBlueprints((prev) => [bp, ...prev]);
                setShowForm(false);
              }}
            />
          ) : (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-border text-xs text-text-muted hover:text-text hover:border-primary/40 transition-colors"
            >
              <Plus className="w-3 h-3" />
              New blueprint
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function BlueprintRow({
  blueprint,
  onDelete,
  onToggle,
  onSpawn,
}: {
  blueprint: any;
  onDelete: () => void;
  onToggle: () => void;
  onSpawn: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [spawning, setSpawning] = useState(false);

  const spawn = async () => {
    setSpawning(true);
    await onSpawn();
    setSpawning(false);
  };

  return (
    <div className="rounded-lg border border-border bg-bg-card">
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-text-muted hover:text-text transition-colors"
          aria-label={expanded ? "Collapse" : "Expand triggers"}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{blueprint.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-bg text-text-muted uppercase tracking-wide">
              {blueprint.spawnMode}
            </span>
          </div>
          <div className="text-[11px] text-text-muted font-mono truncate mt-0.5">
            {blueprint.dir ?? blueprint.repoUrl ?? "any dir"} · {blueprint.commandTemplate}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1.5">
          <button
            onClick={onToggle}
            className={cn(
              "px-2 py-1 rounded-md text-[11px] font-medium transition-colors",
              blueprint.enabled
                ? "bg-success/10 text-success"
                : "bg-bg border border-border text-text-muted hover:text-text",
            )}
            title={blueprint.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
          >
            {blueprint.enabled ? "Enabled" : "Disabled"}
          </button>
          <button
            onClick={spawn}
            disabled={spawning}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-white text-[11px] font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
          >
            {spawning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Spawn
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-md text-text-muted hover:text-error transition-colors"
            title="Delete blueprint"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {expanded && <TriggerList blueprintId={blueprint.id} />}
    </div>
  );
}

function TriggerList({ blueprintId }: { blueprintId: string }) {
  const [triggers, setTriggers] = useState<any[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    api
      .listLocalBlueprintTriggers(blueprintId)
      .then((res) => setTriggers(res.triggers))
      .catch(() => setTriggers([]));
  }, [blueprintId]);

  const handleDelete = async (triggerId: string) => {
    try {
      await api.deleteLocalBlueprintTrigger(blueprintId, triggerId);
      setTriggers((prev) => (prev ?? []).filter((t) => t.id !== triggerId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete trigger");
    }
  };

  return (
    <div className="border-t border-border/60 px-3 py-2.5 space-y-2">
      {triggers === null ? (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Loader2 className="w-3 h-3 animate-spin" />
          Loading triggers...
        </div>
      ) : triggers.length === 0 ? (
        <p className="text-xs text-text-muted/70">No triggers — spawn manually or add one.</p>
      ) : (
        triggers.map((t) => {
          const Icon = TRIGGER_ICONS[t.type] ?? Play;
          return (
            <div key={t.id} className="flex items-center gap-2 text-xs">
              <Icon className="w-3.5 h-3.5 text-text-muted shrink-0" />
              <span className="uppercase tracking-wide text-[10px] text-text-muted w-16 shrink-0">
                {t.type}
              </span>
              <span className="font-mono text-text-muted truncate flex-1">{triggerSummary(t)}</span>
              {!t.enabled && <span className="text-[10px] text-text-muted/60">disabled</span>}
              <button
                onClick={() => handleDelete(t.id)}
                className="p-1 rounded text-text-muted hover:text-error transition-colors shrink-0"
                title="Delete trigger"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })
      )}

      {showAdd ? (
        <AddTriggerForm
          blueprintId={blueprintId}
          onCancel={() => setShowAdd(false)}
          onCreated={(t) => {
            setTriggers((prev) => [...(prev ?? []), t]);
            setShowAdd(false);
          }}
        />
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add trigger
        </button>
      )}
    </div>
  );
}

function AddTriggerForm({
  blueprintId,
  onCancel,
  onCreated,
}: {
  blueprintId: string;
  onCancel: () => void;
  onCreated: (trigger: any) => void;
}) {
  const [type, setType] = useState<TriggerType>("schedule");
  const [cron, setCron] = useState("0 9 * * *");
  const [path, setPath] = useState(`local-${Math.random().toString(36).slice(2, 10)}`);
  const [source, setSource] = useState<(typeof TICKET_SOURCES)[number]>("github");
  const [labels, setLabels] = useState("");
  const [saving, setSaving] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const handleCreate = async () => {
    let config: Record<string, unknown>;
    if (type === "schedule") {
      if (cron.trim().split(/\s+/).length !== 5) {
        toast.error("Cron expression needs five space-separated fields");
        return;
      }
      config = { cronExpression: cron.trim() };
    } else if (type === "webhook") {
      if (!path.trim()) {
        toast.error("Webhook path is required");
        return;
      }
      config = { path: path.trim() };
    } else {
      const labelList = labels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);
      config = { source, ...(labelList.length ? { labels: labelList } : {}) };
    }
    setSaving(true);
    try {
      const res = await api.createLocalBlueprintTrigger(blueprintId, { type, config });
      toast.success("Trigger added");
      onCreated(res.trigger);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add trigger");
    }
    setSaving(false);
  };

  return (
    <div className="rounded-md border border-border bg-bg p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as TriggerType)}
          className="px-2 py-1.5 rounded bg-bg-card border border-border text-xs focus:outline-none focus:border-primary"
        >
          <option value="schedule">Schedule</option>
          <option value="webhook">Webhook</option>
          <option value="ticket">Ticket</option>
        </select>

        {type === "schedule" && (
          <input
            type="text"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 9 * * *"
            className="flex-1 px-2 py-1.5 rounded bg-bg-card border border-border font-mono text-xs focus:outline-none focus:border-primary"
          />
        )}
        {type === "webhook" && (
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="my-hook-path"
            className="flex-1 px-2 py-1.5 rounded bg-bg-card border border-border font-mono text-xs focus:outline-none focus:border-primary"
          />
        )}
        {type === "ticket" && (
          <>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as (typeof TICKET_SOURCES)[number])}
              className="px-2 py-1.5 rounded bg-bg-card border border-border text-xs focus:outline-none focus:border-primary"
            >
              {TICKET_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="labels, comma-separated (optional)"
              className="flex-1 px-2 py-1.5 rounded bg-bg-card border border-border text-xs focus:outline-none focus:border-primary"
            />
          </>
        )}
      </div>

      {type === "webhook" && path.trim() && (
        <p className="text-[11px] text-text-muted font-mono break-all">
          POST {origin}/api/hooks/{path.trim()}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleCreate}
          disabled={saving}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-primary text-white text-[11px] font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          Add
        </button>
        <button
          onClick={onCancel}
          className="px-2.5 py-1 rounded border border-border text-[11px] text-text-muted hover:text-text transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function NewBlueprintForm({
  hosts,
  onCancel,
  onCreated,
}: {
  hosts: any[];
  onCancel: () => void;
  onCreated: (blueprint: any) => void;
}) {
  const [name, setName] = useState("");
  const [hostId, setHostId] = useState("");
  const [locationKind, setLocationKind] = useState<"dir" | "repoUrl">("dir");
  const [dir, setDir] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [commandTemplate, setCommandTemplate] = useState("");
  const [spawnMode, setSpawnMode] = useState<"auto" | "hold">("hold");
  const [saving, setSaving] = useState(false);

  const host = hosts.find((h) => h.id === hostId);

  const handleCreate = async () => {
    if (!name.trim() || !commandTemplate.trim()) {
      toast.error("Name and command template are required");
      return;
    }
    const location = locationKind === "dir" ? dir.trim() : repoUrl.trim();
    if (!location) {
      toast.error(locationKind === "dir" ? "Directory is required" : "Repo URL is required");
      return;
    }
    setSaving(true);
    try {
      const res = await api.createLocalBlueprint({
        name: name.trim(),
        hostId: hostId || undefined,
        dir: locationKind === "dir" ? dir.trim() : undefined,
        repoUrl: locationKind === "repoUrl" ? repoUrl.trim() : undefined,
        commandTemplate: commandTemplate.trim(),
        spawnMode,
      });
      toast.success("Blueprint created");
      onCreated(res.blueprint);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create blueprint");
    }
    setSaving(false);
  };

  return (
    <div className="rounded-lg border border-border bg-bg-card p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. triage ticket"
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            Host <span className="text-text-muted/60">(optional — any online host)</span>
          </label>
          <select
            value={hostId}
            onChange={(e) => {
              setHostId(e.target.value);
              setDir("");
            }}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary"
          >
            <option value="">Any host</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-3 mb-1">
          {(["dir", "repoUrl"] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5 text-xs text-text-muted">
              <input
                type="radio"
                name="bp-location"
                checked={locationKind === k}
                onChange={() => setLocationKind(k)}
                className="accent-[#6d28d9]"
              />
              {k === "dir" ? "Directory" : "Repo URL"}
            </label>
          ))}
        </div>
        {locationKind === "dir" ? (
          host && host.dirs?.length > 0 ? (
            <select
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary"
            >
              <option value="">Pick a directory…</option>
              {host.dirs.map((d: any) => (
                <option key={d.path} value={d.path}>
                  {d.path}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="/absolute/path/on/the/host"
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary"
            />
          )
        ) : (
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo — resolved against the host's dir list"
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary"
          />
        )}
      </div>

      <div>
        <label className="block text-xs text-text-muted mb-1">Command template</label>
        <textarea
          value={commandTemplate}
          onChange={(e) => setCommandTemplate(e.target.value)}
          rows={2}
          placeholder={"claude {{prompt}}"}
          className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary resize-y"
        />
        <p className="text-[11px] text-text-muted/70 mt-1">
          Params are pre-shell-quoted: write{" "}
          <code className="font-mono">claude {"{{prompt}}"}</code>, not{" "}
          <code className="font-mono">claude &quot;{"{{prompt}}"}&quot;</code>.
        </p>
      </div>

      <div>
        <label className="block text-xs text-text-muted mb-1">Spawn mode</label>
        <select
          value={spawnMode}
          onChange={(e) => setSpawnMode(e.target.value as "auto" | "hold")}
          className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary"
        >
          <option value="hold">hold — create pending, start with one click</option>
          <option value="auto">auto — spawn immediately</option>
        </select>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleCreate}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          Create blueprint
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md border border-border text-xs text-text-muted hover:text-text transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
