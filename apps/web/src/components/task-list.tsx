"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import { useStore } from "@/hooks/use-store";
import { TaskCard } from "./task-card";
import { Loader2, ChevronUp, ChevronDown, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const STATE_FILTERS = [
  { value: "", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "needs_attention", label: "Needs Attention" },
  { value: "pr_opened", label: "PR Opened" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

export function TaskList() {
  const { tasks, setTasks } = useStore();
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    api
      .listTasks({ state: filter || undefined, limit: 100 })
      .then((res) => setTasks(res.tasks))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filter, setTasks]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filteredTasks = filter ? tasks.filter((t) => t.state === filter) : tasks;

  // Separate tasks into running, queued, and other
  const runningTasks = filteredTasks.filter((t) => ["running", "provisioning"].includes(t.state));
  const queuedTasks = filteredTasks.filter((t) => t.state === "queued" || t.state === "pending");
  const otherTasks = filteredTasks.filter(
    (t) => !["running", "provisioning", "queued", "pending"].includes(t.state),
  );

  const moveTask = async (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= queuedTasks.length) return;

    const reordered = [...queuedTasks];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(newIndex, 0, moved);

    // Optimistic update
    const newTasks = [...runningTasks, ...reordered, ...otherTasks];
    setTasks(newTasks);

    // Save to backend
    try {
      await api.reorderTasks(reordered.map((t) => t.id));
    } catch {
      toast.error("Failed to reorder");
      refresh();
    }
  };

  return (
    <div>
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {STATE_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "px-3 py-1 rounded-md text-xs transition-colors",
              filter === f.value
                ? "bg-primary text-white"
                : "bg-bg-card text-text-muted hover:bg-bg-hover",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading tasks...
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          <p>No tasks found</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Running tasks first */}
          {runningTasks.length > 0 && (
            <div className="grid gap-2">
              {runningTasks.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          )}

          {/* Queued/pending tasks — reorderable */}
          {queuedTasks.length > 0 && (
            <div>
              {(filter === "" || filter === "queued") && queuedTasks.length > 1 && (
                <div className="text-xs text-text-muted mb-2 flex items-center gap-1">
                  <GripVertical className="w-3 h-3" />
                  Queue order — use arrows to reprioritize
                </div>
              )}
              <div className="grid gap-2">
                {queuedTasks.map((task, i) => (
                  <div key={task.id} className="flex items-center gap-1">
                    {queuedTasks.length > 1 && (
                      <div className="flex flex-col shrink-0">
                        <button
                          onClick={() => moveTask(i, "up")}
                          disabled={i === 0}
                          className="p-0.5 text-text-muted hover:text-text disabled:opacity-20"
                        >
                          <ChevronUp className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => moveTask(i, "down")}
                          disabled={i === queuedTasks.length - 1}
                          className="p-0.5 text-text-muted hover:text-text disabled:opacity-20"
                        >
                          <ChevronDown className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <TaskCard task={task} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Other tasks */}
          {otherTasks.length > 0 && (
            <div className="grid gap-2">
              {otherTasks.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
