"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import { StateBadge } from "@/components/state-badge";
import { Search, X, Loader2, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";

interface AddDependencyDialogProps {
  taskId: string;
  existingDependencyIds: string[];
  onAdd: (dependsOnId: string) => Promise<void>;
  onClose: () => void;
}

export function AddDependencyDialog({
  taskId,
  existingDependencyIds,
  onAdd,
  onClose,
}: AddDependencyDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const excludeIds = new Set([taskId, ...existingDependencyIds]);

  const search = useCallback(
    async (q: string) => {
      setSearching(true);
      setError(null);
      try {
        const res = await api.searchTasks({ q: q || undefined, limit: 20 });
        setResults(res.tasks.filter((t: any) => !excludeIds.has(t.id)));
      } catch {
        setResults([]);
      }
      setSearching(false);
    },
    [taskId, existingDependencyIds.join(",")],
  );

  useEffect(() => {
    const timer = setTimeout(() => search(query), 300);
    return () => clearTimeout(timer);
  }, [query, search]);

  const handleAdd = async (depTaskId: string) => {
    setAdding(depTaskId);
    setError(null);
    try {
      await onAdd(depTaskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add dependency");
      setAdding(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-medium">Add Dependency</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-hover text-text-muted transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tasks by title or ID..."
              autoFocus
              className={inputClass({ className: "pl-8" })}
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 text-xs text-error bg-error/5 border-b border-error/20">
            {error}
          </div>
        )}

        {/* Results */}
        <div className="flex-1 overflow-auto">
          {searching ? (
            <div className="flex items-center justify-center py-8 text-text-muted text-sm">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Searching...
            </div>
          ) : results.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-text-muted text-sm">
              {query ? "No matching tasks found" : "No tasks available"}
            </div>
          ) : (
            <div className="py-1">
              {results.map((task: any) => (
                <button
                  key={task.id}
                  onClick={() => handleAdd(task.id)}
                  disabled={adding !== null}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-bg-hover transition-colors disabled:opacity-50",
                    adding === task.id && "bg-primary/5",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{task.title}</div>
                    <div className="text-[10px] text-text-muted font-mono mt-0.5">
                      {task.id.slice(0, 8)}
                      {task.repoUrl && (
                        <span className="ml-2">
                          {task.repoUrl.replace(/.*\/\/[^/]+\//, "").replace(/\.git$/, "")}
                        </span>
                      )}
                    </div>
                  </div>
                  <StateBadge state={task.state} />
                  {adding === task.id && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
