"use client";

import { SectionCard } from "@/components/ui/section-card";
import { useState, useEffect } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Plus, X, Trash2, RotateCcw, RefreshCw, AlertTriangle, Loader2 } from "lucide-react";

interface SharedDirectory {
  id: string;
  repoId: string;
  name: string;
  description: string | null;
  mountLocation: string;
  mountSubPath: string;
  sizeGi: number;
  scope: string;
  lastClearedAt: string | null;
  lastMountedAt: string | null;
  createdAt: string;
}

interface CachePreset {
  label: string;
  name: string;
  mountLocation: "workspace" | "home";
  mountSubPath: string;
  sizeGi: number;
  description: string;
}

const CACHE_PRESETS: CachePreset[] = [
  {
    label: "npm",
    name: "npm-cache",
    mountLocation: "home",
    mountSubPath: ".npm",
    sizeGi: 10,
    description: "npm global cache",
  },
  {
    label: "pnpm",
    name: "pnpm-store",
    mountLocation: "home",
    mountSubPath: ".local/share/pnpm/store",
    sizeGi: 10,
    description: "pnpm content-addressable store",
  },
  {
    label: "pip",
    name: "pip-cache",
    mountLocation: "home",
    mountSubPath: ".cache/pip",
    sizeGi: 10,
    description: "pip download cache",
  },
  {
    label: "uv",
    name: "uv-cache",
    mountLocation: "home",
    mountSubPath: ".cache/uv",
    sizeGi: 10,
    description: "uv package manager cache",
  },
  {
    label: "cargo",
    name: "cargo-registry",
    mountLocation: "home",
    mountSubPath: ".cargo/registry",
    sizeGi: 20,
    description: "Cargo crate registry",
  },
  {
    label: "Go modules",
    name: "go-mod",
    mountLocation: "home",
    mountSubPath: "go/pkg/mod",
    sizeGi: 10,
    description: "Go module download cache",
  },
  {
    label: "Gradle",
    name: "gradle-cache",
    mountLocation: "home",
    mountSubPath: ".gradle/caches",
    sizeGi: 20,
    description: "Gradle dependency caches",
  },
  {
    label: "Maven",
    name: "maven-repo",
    mountLocation: "home",
    mountSubPath: ".m2/repository",
    sizeGi: 20,
    description: "Maven local repository",
  },
  {
    label: "HuggingFace",
    name: "huggingface",
    mountLocation: "home",
    mountSubPath: ".cache/huggingface",
    sizeGi: 50,
    description: "HuggingFace model cache",
  },
  {
    label: "Poetry",
    name: "poetry-cache",
    mountLocation: "home",
    mountSubPath: ".cache/pypoetry",
    sizeGi: 10,
    description: "Poetry dependency cache",
  },
];

export function SharedDirectoriesSection({
  repoId,
  maxPodInstances,
}: {
  repoId: string;
  maxPodInstances?: number;
}) {
  const [directories, setDirectories] = useState<SharedDirectory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string>("custom");
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newMountLocation, setNewMountLocation] = useState<"workspace" | "home">("home");
  const [newMountSubPath, setNewMountSubPath] = useState("");
  const [newSizeGi, setNewSizeGi] = useState(10);
  const [addingDir, setAddingDir] = useState(false);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [usageMap, setUsageMap] = useState<Record<string, string | null>>({});
  const [recycling, setRecycling] = useState(false);

  useEffect(() => {
    api
      .listRepoSharedDirectories(repoId)
      .then((res) => setDirectories(res.directories))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [repoId]);

  const applyPreset = (presetLabel: string) => {
    setSelectedPreset(presetLabel);
    if (presetLabel === "custom") {
      setNewName("");
      setNewDescription("");
      setNewMountLocation("home");
      setNewMountSubPath("");
      setNewSizeGi(10);
      return;
    }
    const preset = CACHE_PRESETS.find((p) => p.label === presetLabel);
    if (preset) {
      setNewName(preset.name);
      setNewDescription(preset.description);
      setNewMountLocation(preset.mountLocation);
      setNewMountSubPath(preset.mountSubPath);
      setNewSizeGi(preset.sizeGi);
    }
  };

  const handleAdd = async () => {
    if (!newName || !newMountSubPath) return;
    setAddingDir(true);
    try {
      const res = await api.createRepoSharedDirectory(repoId, {
        name: newName,
        description: newDescription || undefined,
        mountLocation: newMountLocation,
        mountSubPath: newMountSubPath,
        sizeGi: newSizeGi,
      });
      setDirectories((prev) => [...prev, res.directory]);
      setShowAdd(false);
      setSelectedPreset("custom");
      setNewName("");
      setNewDescription("");
      setNewMountSubPath("");
      setNewSizeGi(10);
      toast.success(`Cache directory "${newName}" created`);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to create cache directory");
    } finally {
      setAddingDir(false);
    }
  };

  const handleDelete = async (dir: SharedDirectory) => {
    try {
      await api.deleteRepoSharedDirectory(repoId, dir.id);
      setDirectories((prev) => prev.filter((d) => d.id !== dir.id));
      toast.success(`Cache directory "${dir.name}" deleted`);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to delete cache directory");
    }
  };

  const handleClear = async (dir: SharedDirectory) => {
    setClearingId(dir.id);
    try {
      await api.clearRepoSharedDirectory(repoId, dir.id);
      toast.success(`Cache "${dir.name}" cleared`);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to clear cache");
    } finally {
      setClearingId(null);
    }
  };

  const handleRefreshUsage = async (dir: SharedDirectory) => {
    try {
      const res = await api.getRepoSharedDirectoryUsage(repoId, dir.id);
      setUsageMap((prev) => ({ ...prev, [dir.id]: res.usage }));
    } catch {
      setUsageMap((prev) => ({ ...prev, [dir.id]: null }));
    }
  };

  const handleRecyclePods = async () => {
    setRecycling(true);
    try {
      const res = await api.recycleRepoPods(repoId);
      toast.success(`Recycled ${res.recycled} pod(s). New pods will be created on next task.`);
    } catch (err: any) {
      toast.error(err.message ?? "Failed to recycle pods");
    } finally {
      setRecycling(false);
    }
  };

  const getMountPathDisplay = (dir: SharedDirectory) => {
    return dir.mountLocation === "home"
      ? `/home/agent/${dir.mountSubPath}`
      : `/workspace/${dir.mountSubPath}`;
  };

  if (loading) return null;

  return (
    <SectionCard
      label="Cache directories"
      hint="Persistent storage that survives across tasks"
      summary={
        directories.length > 0
          ? `${directories.length} ${directories.length === 1 ? "directory" : "directories"}`
          : "none"
      }
      actions={
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Cache
        </button>
      }
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        Use for package caches, build artifacts, model downloads, etc. Each pod instance gets its
        own copy.
      </p>

      {(maxPodInstances ?? 1) > 1 && (
        <div className="flex items-start gap-2 p-2.5 rounded-lg border border-warning/30 bg-warning/5 text-xs text-warning">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            This repo scales to {maxPodInstances} pod instances. Each instance gets its own cache
            copy &mdash; the first task on each new instance will populate the cache from scratch.
          </span>
        </div>
      )}

      {directories.length > 0 && (
        <div className="space-y-2">
          {directories.map((dir) => (
            <div
              key={dir.id}
              className="flex items-start gap-3 p-3 rounded-lg border border-border bg-bg"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{dir.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-muted">
                    {dir.sizeGi}Gi
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-muted">
                    {dir.mountLocation}
                  </span>
                </div>
                <p className="text-xs text-text-muted mt-0.5 font-mono truncate">
                  {getMountPathDisplay(dir)}
                </p>
                {dir.description && (
                  <p className="text-xs text-text-muted mt-0.5">{dir.description}</p>
                )}
                {usageMap[dir.id] !== undefined && (
                  <p className="text-xs text-text-muted mt-0.5">
                    Usage: {usageMap[dir.id] ?? "N/A"}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => handleRefreshUsage(dir)}
                  className="text-text-muted hover:text-text p-1"
                  title="Check usage"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleClear(dir)}
                  disabled={clearingId === dir.id}
                  className="text-text-muted hover:text-warning p-1"
                  title="Clear cache contents"
                >
                  {clearingId === dir.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="w-3.5 h-3.5" />
                  )}
                </button>
                <button
                  onClick={() => handleDelete(dir)}
                  className="text-text-muted hover:text-error p-1"
                  title="Delete cache directory"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {directories.length > 0 && (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleRecyclePods}
            disabled={recycling}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text"
          >
            {recycling ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RotateCcw className="w-3.5 h-3.5" />
            )}
            Recycle idle pods
          </button>
          <span className="text-[10px] text-text-muted">
            Force-recreate pods to pick up mount changes
          </span>
        </div>
      )}

      {showAdd && (
        <div className="space-y-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
          <div>
            <label className="block text-xs text-text-muted mb-1">Preset</label>
            <select
              value={selectedPreset}
              onChange={(e) => applyPreset(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            >
              <option value="custom">Custom</option>
              {CACHE_PRESETS.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label} &mdash; {p.mountSubPath}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Name (slug)</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="npm-cache"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Size (Gi)</label>
              <input
                type="number"
                min={1}
                max={100}
                value={newSizeGi}
                onChange={(e) => setNewSizeGi(parseInt(e.target.value) || 10)}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">Description (optional)</label>
            <input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="npm global cache"
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Mount location</label>
              <select
                value={newMountLocation}
                onChange={(e) => setNewMountLocation(e.target.value as "workspace" | "home")}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              >
                <option value="home">Agent home (~)</option>
                <option value="workspace">Workspace (/workspace)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Sub-path</label>
              <input
                value={newMountSubPath}
                onChange={(e) => setNewMountSubPath(e.target.value)}
                placeholder=".npm"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>

          {newMountSubPath && (
            <p className="text-xs text-text-muted font-mono">
              Mount path:{" "}
              {newMountLocation === "home"
                ? `/home/agent/${newMountSubPath}`
                : `/workspace/${newMountSubPath}`}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleAdd}
              disabled={addingDir || !newName || !newMountSubPath}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-40"
            >
              {addingDir && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Add
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="text-xs text-text-muted hover:text-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
