"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Bot, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { StateBadge } from "@/components/state-badge";
import { AddDependencyDialog } from "@/components/add-dependency-dialog";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

export function TaskRelations({
  task,
  refresh,
  onSubtasks,
}: {
  task: any;
  refresh: () => void;
  onSubtasks: (tasks: any[]) => void;
}) {
  const id = task.id;
  const [actionLoading, setActionLoading] = useState(false);
  const [subtasks, setSubtasks] = useState<any[]>([]);
  const [dependencies, setDependencies] = useState<any[]>([]);
  const [dependents, setDependents] = useState<any[]>([]);
  const [showCreateSubtask, setShowCreateSubtask] = useState(false);
  const [showAddDependency, setShowAddDependency] = useState(false);
  const [newSubtask, setNewSubtask] = useState({
    title: "",
    prompt: "",
    taskType: "child",
    blocksParent: false,
  });

  // Re-read the relations as the task moves through its states.
  const taskState = task.state;
  useEffect(() => {
    api
      .getSubtasks(id)
      .then((res) => {
        setSubtasks(res.subtasks);
        onSubtasks(res.subtasks);
      })
      .catch(() => {});
    api
      .getTaskDependencies(id)
      .then((res) => setDependencies(res.dependencies))
      .catch(() => {});
    api
      .getTaskDependents(id)
      .then((res) => setDependents(res.dependents))
      .catch(() => {});
  }, [id, taskState, onSubtasks]);

  const handleCreateSubtask = async () => {
    if (!newSubtask.title.trim() || !newSubtask.prompt.trim()) return;
    setActionLoading(true);
    try {
      await api.createSubtask(id, {
        title: newSubtask.title,
        prompt: newSubtask.prompt,
        taskType: newSubtask.taskType as any,
        blocksParent: newSubtask.blocksParent,
      });
      toast.success("Subtask created and queued");
      setShowCreateSubtask(false);
      setNewSubtask({ title: "", prompt: "", taskType: "child", blocksParent: false });
      // Refresh subtasks
      const res = await api.getSubtasks(id);
      setSubtasks(res.subtasks);
      onSubtasks(res.subtasks);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create subtask");
    }
    setActionLoading(false);
  };

  return (
    <div className="space-y-3">
      {/* Dependencies */}
      <div className="rounded-xl border border-border bg-bg-card py-3">
        <div className="px-4">
          <div className={dependencies.length > 0 ? "mb-2" : ""}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-medium text-text-muted">
                {dependencies.length > 0
                  ? `Depends on (${dependencies.filter((d: any) => d.state === "completed" || d.state === "pr_opened").length}/${dependencies.length} complete)`
                  : "Dependencies"}
              </h3>
              <button
                onClick={() => setShowAddDependency(true)}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus className="w-3 h-3" />
                Add Dependency
              </button>
            </div>
            {dependencies.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {dependencies.map((dep: any) => (
                  <div
                    key={dep.id}
                    className={cn(
                      "inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border group",
                      dep.state === "completed" || dep.state === "pr_opened"
                        ? "border-success/30 text-success bg-success/5"
                        : dep.state === "failed"
                          ? "border-error/30 text-error bg-error/5"
                          : "border-border text-text-muted bg-bg-card",
                    )}
                  >
                    <Link href={`/work/${dep.id}`} className="inline-flex items-center gap-1.5">
                      {dep.title}
                      <span className="opacity-60">{dep.state}</span>
                    </Link>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Remove dependency on "${dep.title}"?`)) return;
                        try {
                          await api.removeTaskDependency(id, dep.id);
                          setDependencies((prev) => prev.filter((d: any) => d.id !== dep.id));
                          toast.success("Dependency removed");
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : "Failed to remove dependency",
                          );
                        }
                      }}
                      className="opacity-60 hover:opacity-100 p-0.5 rounded hover:bg-bg-hover transition-opacity"
                      title="Remove dependency"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-text-muted/60">
                No dependencies. Add one to ensure this task waits for another to complete.
              </p>
            )}
          </div>
          {dependents.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-text-muted mb-1">
                Blocks ({dependents.length} task{dependents.length !== 1 ? "s" : ""})
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {dependents.map((dep: any) => (
                  <Link
                    key={dep.id}
                    href={`/work/${dep.id}`}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border border-border text-text-muted bg-bg-card hover:bg-bg-hover"
                  >
                    {dep.title}
                    <span className="opacity-60">{dep.state}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add Dependency Dialog */}
      {showAddDependency && (
        <AddDependencyDialog
          taskId={id}
          existingDependencyIds={dependencies.map((d: any) => d.id)}
          onAdd={async (depId) => {
            await api.addTaskDependencies(id, [depId]);
            const res = await api.getTaskDependencies(id);
            setDependencies(res.dependencies);
            setShowAddDependency(false);
            toast.success("Dependency added");
          }}
          onClose={() => setShowAddDependency(false)}
        />
      )}

      {/* Subtasks */}
      {(subtasks.length > 0 || task.state === "pr_opened" || task.state === "running") && (
        <div className="rounded-xl border border-border bg-bg-card py-3">
          <div className="px-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-medium text-text-muted">
                Subtasks{" "}
                {subtasks.length > 0 &&
                  `(${subtasks.filter((s: any) => s.state === "completed").length}/${subtasks.length})`}
              </h3>
              <button
                onClick={() => setShowCreateSubtask(!showCreateSubtask)}
                className="text-xs text-primary hover:underline"
              >
                {showCreateSubtask ? "Cancel" : "+ Add subtask"}
              </button>
            </div>

            {/* Create subtask form */}
            {showCreateSubtask && (
              <div className="p-3 rounded-md border border-border bg-bg-card space-y-2 mb-2">
                <input
                  value={newSubtask.title}
                  onChange={(e) => setNewSubtask((s) => ({ ...s, title: e.target.value }))}
                  placeholder="Subtask title"
                  className={inputClass({ size: "sm" })}
                />
                <textarea
                  value={newSubtask.prompt}
                  onChange={(e) => setNewSubtask((s) => ({ ...s, prompt: e.target.value }))}
                  placeholder="What should the agent do?"
                  rows={3}
                  className={inputClass({ size: "sm", className: "font-mono resize-y" })}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <select
                    value={newSubtask.taskType}
                    onChange={(e) => setNewSubtask((s) => ({ ...s, taskType: e.target.value }))}
                    className={inputClass({ size: "sm", className: "w-auto" })}
                  >
                    <option value="child">Child task</option>
                    <option value="step">Sequential step</option>
                    <option value="review">Code review</option>
                  </select>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newSubtask.blocksParent}
                      onChange={(e) =>
                        setNewSubtask((s) => ({ ...s, blocksParent: e.target.checked }))
                      }
                      className="w-3 h-3 rounded"
                    />
                    Blocks parent
                  </label>
                  <Button
                    size="sm"
                    onClick={handleCreateSubtask}
                    disabled={actionLoading || !newSubtask.title.trim()}
                    className="ml-auto btn-press"
                  >
                    Create & Queue
                  </Button>
                </div>
              </div>
            )}

            {/* Subtask list */}
            {subtasks.length > 0 && (
              <div className="space-y-1">
                {subtasks.map((sub: any) => {
                  const isStep = sub.taskType === "step";
                  const stepIndex = isStep
                    ? subtasks.filter((s: any) => s.taskType === "step").indexOf(sub) + 1
                    : 0;
                  return (
                    <Link
                      key={sub.id}
                      href={`/work/${sub.id}`}
                      className={cn(
                        "flex items-center gap-2 p-2 rounded-md border text-xs transition-colors hover:bg-bg-hover",
                        sub.taskType === "review"
                          ? "border-info/20 bg-info/5"
                          : isStep
                            ? sub.state === "completed"
                              ? "border-success/20 bg-success/5"
                              : sub.state === "failed"
                                ? "border-error/20 bg-error/5"
                                : ["running", "provisioning", "queued"].includes(sub.state)
                                  ? "border-primary/20 bg-primary/5"
                                  : "border-border bg-bg-card"
                            : sub.blocksParent
                              ? "border-warning/20 bg-warning/5"
                              : "border-border bg-bg-card",
                      )}
                    >
                      {sub.taskType === "review" ? (
                        <Bot className="w-3.5 h-3.5 text-info shrink-0" />
                      ) : isStep ? (
                        <span
                          className={cn(
                            "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0",
                            sub.state === "completed"
                              ? "bg-success/20 text-success"
                              : sub.state === "failed"
                                ? "bg-error/20 text-error"
                                : ["running", "provisioning", "queued"].includes(sub.state)
                                  ? "bg-primary/20 text-primary"
                                  : "bg-border text-text-muted",
                          )}
                        >
                          {stepIndex}
                        </span>
                      ) : sub.blocksParent ? (
                        <span className="w-3.5 h-3.5 text-warning shrink-0 text-center font-bold">
                          !
                        </span>
                      ) : (
                        <span className="w-3.5 h-3.5 text-text-muted shrink-0 text-center">•</span>
                      )}
                      <span className="truncate flex-1">{sub.title}</span>
                      {isStep && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-bg-hover text-text-muted shrink-0">
                          step
                        </span>
                      )}
                      {sub.blocksParent && !isStep && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-warning/10 text-warning shrink-0">
                          blocking
                        </span>
                      )}
                      <StateBadge state={sub.state} />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
