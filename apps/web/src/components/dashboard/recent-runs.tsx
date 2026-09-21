import Link from "next/link";
import { Bot, GitPullRequest, ListTodo, Plus, Terminal } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { EmptyState } from "./empty-state.js";

export interface RecentRun {
  id: string;
  kind: "task" | "job-run" | "agent-turn";
  title: string;
  state: string;
  href: string;
  where: string | null;
  detail: string | null;
  agentType: string | null;
  costUsd: string | null;
  at: string;
}

const KIND: Record<RecentRun["kind"], { icon: typeof Bot; label: string }> = {
  task: { icon: GitPullRequest, label: "Task" },
  "job-run": { icon: Terminal, label: "Job" },
  "agent-turn": { icon: Bot, label: "Agent" },
};

/** One color vocabulary for three state vocabularies. */
export function runTone(state: string): { dot: string; text: string; label: string } {
  switch (state) {
    case "running":
    case "provisioning":
      return { dot: "bg-success animate-pulse", text: "text-success", label: "running" };
    case "queued":
    case "pending":
      return { dot: "bg-text-muted/50", text: "text-text-muted", label: "queued" };
    case "pr_opened":
      return { dot: "bg-info", text: "text-info", label: "PR open" };
    case "needs_attention":
      return { dot: "bg-warning animate-pulse", text: "text-warning", label: "needs attention" };
    case "failed":
    case "error":
      return { dot: "bg-error", text: "text-error", label: "failed" };
    case "cancelled":
      return { dot: "bg-text-muted/40", text: "text-text-muted", label: "cancelled" };
    case "completed":
      return { dot: "bg-text-muted/40", text: "text-text-muted", label: "done" };
    default:
      return { dot: "bg-text-muted/40", text: "text-text-muted", label: state.replace(/_/g, " ") };
  }
}

/**
 * The overview's "Recent" panel: one newest-first feed of repo tasks, job
 * runs, and persistent-agent turns, each linking to its own page.
 */
export function RecentRuns({ runs }: { runs: RecentRun[] }) {
  return (
    <div className="min-w-0 overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-text-heading">Recent</h2>
        <div className="flex items-center gap-2">
          <Link
            href="/work/new"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> New task
          </Link>
          <Link href="/work?view=history" className="text-xs text-primary hover:underline">
            All &rarr;
          </Link>
        </div>
      </div>
      {runs.length === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="Nothing has run yet"
          description="Tasks, job runs, and agent turns will show up here as they happen."
          action={{ label: "Create a task", href: "/work/new" }}
        />
      ) : (
        <div className="rounded-xl border border-border/50 bg-bg-card divide-y divide-border/40 overflow-hidden">
          {runs.map((run) => {
            const k = KIND[run.kind];
            const Icon = k.icon;
            const tone = runTone(run.state);
            return (
              <Link
                key={`${run.kind}-${run.id}`}
                href={run.href}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-bg-hover/60 transition-colors min-w-0"
              >
                <span
                  className="w-7 h-7 rounded-md bg-bg flex items-center justify-center shrink-0 text-text-muted"
                  title={k.label}
                >
                  <Icon className="w-3.5 h-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-medium truncate">{run.title}</span>
                    {run.where && (
                      <span className="text-[10px] font-mono text-text-muted truncate hidden sm:inline">
                        {run.where}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-text-muted mt-0.5 min-w-0">
                    <span className={cn("flex items-center gap-1 shrink-0", tone.text)}>
                      <span className={cn("w-1.5 h-1.5 rounded-full", tone.dot)} />
                      {tone.label}
                    </span>
                    <span className="text-text-muted/50 shrink-0">{k.label.toLowerCase()}</span>
                    {run.agentType && (
                      <span className="text-text-muted/50 shrink-0 hidden md:inline">
                        {run.agentType}
                      </span>
                    )}
                    {run.detail && <span className="truncate">{run.detail}</span>}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10px] text-text-muted tabular-nums">
                    {formatRelativeTime(run.at)}
                  </div>
                  {run.costUsd && parseFloat(run.costUsd) > 0 && (
                    <div className="text-[10px] font-mono text-text-muted/70 tabular-nums">
                      ${parseFloat(run.costUsd).toFixed(2)}
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
