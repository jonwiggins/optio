import Link from "next/link";
import { AlertTriangle, GitPullRequest, Laptop, Zap } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import { attentionLabel, dirTail } from "@/components/local/terminal-card";

export interface NeedsYouItem {
  key: string;
  kind: "local" | "task";
  href: string;
  title: string;
  /** Why it's waiting. */
  reason: string;
  /** Where it lives — repo, dir. */
  where: string | null;
  /** When it started waiting (for the "oldest first" order + relative time). */
  since: string | null;
}

/** Everything across concepts that is waiting on a human, oldest first. */
export function collectNeedsYou(localTerminals: any[], attentionTasks: any[]): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const t of localTerminals) {
    if (t.attentionState !== "needs_you") continue;
    items.push({
      key: `local-${t.id}`,
      kind: "local",
      href: `/local/${t.id}`,
      title: t.title,
      reason: attentionLabel(t.attentionReason),
      where: dirTail(t.dir),
      since: t.lastActivityAt ?? t.updatedAt ?? null,
    });
  }
  for (const task of attentionTasks) {
    items.push({
      key: `task-${task.id}`,
      kind: "task",
      href: `/tasks/${task.id}`,
      title: task.title,
      reason: task.errorMessage ?? "needs attention",
      where: task.repoUrl ? task.repoUrl.replace(/^https?:\/\/[^/]+\//, "") : null,
      since: task.updatedAt ?? null,
    });
  }
  return items.sort((a, b) => {
    const at = a.since ? new Date(a.since).getTime() : 0;
    const bt = b.since ? new Date(b.since).getTime() : 0;
    return at - bt;
  });
}

const KIND_ICON = { local: Laptop, task: GitPullRequest } as const;

/**
 * The overview's first section: one list of everything waiting on you,
 * whatever concept it belongs to. Renders nothing when the list is empty —
 * the best state for this strip is not existing.
 */
export function NeedsYou({ items, max = 6 }: { items: NeedsYouItem[]; max?: number }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <section className="rounded-xl border border-warning/30 bg-warning/[0.04] p-3 sm:p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold tracking-widest uppercase text-warning flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5" />
          Needs you
          <span className="font-normal opacity-70">{items.length}</span>
        </h2>
        {rest > 0 && <span className="text-[11px] text-text-muted">+{rest} more</span>}
      </div>
      <div className="grid md:grid-cols-2 gap-1.5">
        {shown.map((item) => {
          const Icon = KIND_ICON[item.kind];
          return (
            <Link
              key={item.key}
              href={item.href}
              className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-bg-card/70 border border-border/60 hover:border-warning/50 hover:bg-bg-hover transition-colors min-w-0"
            >
              <Icon className="w-3.5 h-3.5 text-text-muted shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-medium truncate">{item.title}</span>
                  {item.where && (
                    <span className="text-[10px] font-mono text-text-muted truncate hidden sm:inline">
                      {item.where}
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-warning truncate">{item.reason}</div>
              </div>
              {item.since && (
                <span className="text-[10px] text-text-muted tabular-nums shrink-0">
                  {formatRelativeTime(item.since)}
                </span>
              )}
              <AlertTriangle className="w-3 h-3 text-warning/70 shrink-0" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
