"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api-client";
import { useStore, type TaskSummary } from "@/hooks/use-store";
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

  // Build parent→review map
  const reviewMap = new Map<string, TaskSummary[]>();
  const topLevelTasks: TaskSummary[] = [];

  for (const t of filteredTasks) {
    if (t.parentTaskId) {
      const existing = reviewMap.get(t.parentTaskId) ?? [];
      existing.push(t);
      reviewMap.set(t.parentTaskId, existing);
    } else {
      topLevelTasks.push(t);
    }
  }

  // Check subtask states for a parent task
  const subtaskStatus = (taskId: string) => {
    const subs = reviewMap.get(taskId) ?? [];
    const hasRunning = subs.some((s) => ["running", "provisioning"].includes(s.state));
    const hasQueued = subs.some((s) => ["queued", "pending"].includes(s.state));
    const hasAny = subs.length > 0;
    const allDone =
      hasAny && subs.every((s) => ["completed", "failed", "cancelled"].includes(s.state));
    return { hasRunning, hasQueued, hasAny, allDone };
  };

  // Split into clear sections
  const running = topLevelTasks.filter((t) => {
    if (["running", "provisioning"].includes(t.state)) return true;
    if (t.state === "pr_opened" && subtaskStatus(t.id).hasRunning) return true;
    return false;
  });
  const queued = topLevelTasks.filter((t) => {
    if (["queued", "pending"].includes(t.state)) return true;
    if (t.state === "pr_opened" && !subtaskStatus(t.id).hasRunning && subtaskStatus(t.id).hasQueued)
      return true;
    return false;
  });
  const awaitingAction = topLevelTasks.filter(
    (t) =>
      t.state === "needs_attention" ||
      (t.state === "pr_opened" && subtaskStatus(t.id).allDone) ||
      (t.state === "pr_opened" && !subtaskStatus(t.id).hasAny),
  );
  const failed = topLevelTasks.filter((t) => ["failed"].includes(t.state));
  const completed = topLevelTasks.filter((t) => ["completed", "cancelled"].includes(t.state));

  const moveTask = async (index: number, direction: "up" | "down") => {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= queued.length) return;

    const reordered = [...queued];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(newIndex, 0, moved);

    const newTasks = [...running, ...reordered, ...awaitingAction, ...failed, ...completed];
    setTasks(newTasks);

    try {
      await api.reorderTasks(reordered.map((t) => t.id));
    } catch {
      toast.error("Failed to reorder");
      refresh();
    }
  };

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-1.5 mb-6 flex-wrap">
        {STATE_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors",
              filter === f.value
                ? "bg-bg-card border border-border text-text"
                : "text-text-muted hover:bg-bg-hover hover:text-text",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading tasks...
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <p>No tasks found</p>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Running */}
          {running.length > 0 && (
            <Section label="Running" count={running.length}>
              {running.map((task) => (
                <TaskCard key={task.id} task={task} subtasks={reviewMap.get(task.id)} />
              ))}
            </Section>
          )}

          {/* Needs human input */}
          {awaitingAction.length > 0 && (
            <Section label="Needs Your Input" count={awaitingAction.length}>
              {awaitingAction.map((task) => (
                <TaskCard key={task.id} task={task} subtasks={reviewMap.get(task.id)} />
              ))}
            </Section>
          )}

          {/* Queue */}
          {queued.length > 0 && (
            <Section label="Queue" count={queued.length}>
              {queued.length > 1 && (
                <div className="text-xs text-text-muted/50 mb-2 flex items-center gap-1.5">
                  <GripVertical className="w-3 h-3" />
                  Use arrows to reprioritize
                </div>
              )}
              {queued.map((task, i) => (
                <div key={task.id} className="flex items-center gap-1.5">
                  {queued.length > 1 && (
                    <div className="flex flex-col shrink-0 rounded-md bg-bg-card p-0.5">
                      <button
                        onClick={() => moveTask(i, "up")}
                        disabled={i === 0}
                        className="p-0.5 text-text-muted hover:text-text disabled:opacity-20 transition-colors"
                      >
                        <ChevronUp className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => moveTask(i, "down")}
                        disabled={i === queued.length - 1}
                        className="p-0.5 text-text-muted hover:text-text disabled:opacity-20 transition-colors"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <TaskCard task={task} subtasks={reviewMap.get(task.id)} />
                  </div>
                </div>
              ))}
            </Section>
          )}

          {/* Failed */}
          {failed.length > 0 && (
            <Section label="Failed" count={failed.length}>
              {failed.map((task) => (
                <TaskCard key={task.id} task={task} subtasks={reviewMap.get(task.id)} />
              ))}
            </Section>
          )}

          {/* Completed */}
          {completed.length > 0 && (
            <Section label="Completed" count={completed.length}>
              {completed.map((task) => (
                <TaskCard key={task.id} task={task} subtasks={reviewMap.get(task.id)} />
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-medium uppercase tracking-wider text-text-muted">
          {label}
        </span>
        <span className="text-xs text-text-muted/40">{count}</span>
      </div>
      <div className="grid gap-2.5">{children}</div>
    </div>
  );
}
