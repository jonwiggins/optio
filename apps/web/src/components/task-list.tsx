"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { useStore, type TaskSummary } from "@/hooks/use-store";
import { TaskCard } from "./task-card";
import { StateBadge } from "./state-badge";
import { Loader2, ChevronUp, ChevronDown, GripVertical, Bot } from "lucide-react";
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

  // Separate review tasks from parent tasks
  const reviewTasks = new Map<string, TaskSummary[]>();
  const parentTasks: TaskSummary[] = [];

  for (const t of filteredTasks) {
    if (t.taskType === "review" && t.parentTaskId) {
      const existing = reviewTasks.get(t.parentTaskId) ?? [];
      existing.push(t);
      reviewTasks.set(t.parentTaskId, existing);
    } else {
      parentTasks.push(t);
    }
  }

  // Split parents into running, queued, other
  const runningTasks = parentTasks.filter((t) =>
    ["running", "provisioning"].includes(t.state),
  );
  const queuedTasks = parentTasks.filter(
    (t) => t.state === "queued" || t.state === "pending",
  );
  const otherTasks = parentTasks.filter(
    (t) => !["running", "provisioning", "queued", "pending"].includes(t.state),
  );

  const moveTask = async (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= queuedTasks.length) return;

    const reordered = [...queuedTasks];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(newIndex, 0, moved);

    const newTasks = [...runningTasks, ...reordered, ...otherTasks];
    setTasks(newTasks);

    try {
      await api.reorderTasks(reordered.map((t) => t.id));
    } catch {
      toast.error("Failed to reorder");
      refresh();
    }
  };

  const renderTaskWithReview = (task: TaskSummary) => {
    const reviews = reviewTasks.get(task.id) ?? [];
    const activeReview = reviews.find((r) =>
      ["running", "provisioning", "queued"].includes(r.state),
    );

    return (
      <div key={task.id}>
        <div className="relative">
          <TaskCard task={task} />
          {/* Review indicator on parent */}
          {activeReview && (
            <div className="mt-1 ml-4 flex items-center gap-2 text-xs text-info">
              <div className="w-px h-3 bg-info/30" />
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Code review in progress...</span>
            </div>
          )}
        </div>
        {/* Nested review subtasks */}
        {reviews.length > 0 && (
          <div className="ml-6 mt-1 space-y-1">
            {reviews.map((review) => (
              <Link
                key={review.id}
                href={`/tasks/${review.id}`}
                className="flex items-center gap-2 p-2 rounded-md border border-info/20 bg-info/5 hover:bg-info/10 transition-colors text-xs"
              >
                <div className="w-px h-6 bg-info/30 -ml-4 shrink-0" />
                <Bot className="w-3.5 h-3.5 text-info shrink-0" />
                <span className="truncate text-text/80">{review.title}</span>
                <StateBadge state={review.state} />
              </Link>
            ))}
          </div>
        )}
      </div>
    );
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
              {runningTasks.map((task) => renderTaskWithReview(task))}
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
                      {renderTaskWithReview(task)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Other tasks */}
          {otherTasks.length > 0 && (
            <div className="grid gap-2">
              {otherTasks.map((task) => renderTaskWithReview(task))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
