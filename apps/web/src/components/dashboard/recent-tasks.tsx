import Link from "next/link";
import { Plus, ListTodo } from "lucide-react";
import { TaskCard } from "@/components/task-card";
import { EmptyState } from "./empty-state.js";

export function RecentTasks({ tasks }: { tasks: any[] }) {
  return (
    <div className="min-w-0 overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-text-heading">Recent Tasks</h2>
        <div className="flex items-center gap-2">
          <Link
            href="/tasks/new"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> New
          </Link>
          <Link href="/tasks" className="text-xs text-primary hover:underline">
            All &rarr;
          </Link>
        </div>
      </div>
      {tasks.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="No tasks yet"
          description="Create your first task to get an AI agent working on your code."
          action={{ label: "Create a task", href: "/tasks/new" }}
        />
      ) : (
        <div className="grid gap-2">
          {tasks.map((task: any) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}
