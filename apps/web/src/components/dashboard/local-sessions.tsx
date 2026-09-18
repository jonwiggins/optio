import Link from "next/link";
import { Laptop, Plus, Server } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { PipelineStatsBar } from "./pipeline-stats-bar.js";
import { StatusDot, attentionLabel, dirTail } from "@/components/local/terminal-card";
import { collectWorkLinks, WorkLinkBadges } from "@/components/local/work-links";
import type { LocalStats } from "./types.js";

/**
 * Overview section for Optio Local: the same stats strip the other
 * concepts get, plus the handful of terminals worth a glance — live ones
 * and anything that finished in the last day, needs-you first.
 */
export function LocalSessions({
  stats,
  terminals,
  hosts,
}: {
  stats: LocalStats | null;
  terminals: any[];
  hosts: any[];
}) {
  const hostName = new Map(hosts.map((h) => [h.id, h.name]));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <Laptop className="w-3 h-3 text-text-muted/60" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted/60">
            Local
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/local?new=1"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> New
          </Link>
          <Link href="/local" className="text-xs text-primary hover:underline">
            All &rarr;
          </Link>
        </div>
      </div>
      <PipelineStatsBar variant="local" localStats={stats} />
      {/* Cards are opt-in: the overview shows live terminals in its Live panel instead. */}
      {terminals.length > 0 && (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2 pt-1">
          {terminals.map((t) => {
            const links = collectWorkLinks(t);
            const needsYou = t.attentionState === "needs_you";
            return (
              <Link
                key={t.id}
                href={`/local/${t.id}`}
                className={cn(
                  "flex items-start gap-2 p-3 rounded-lg border bg-bg-card transition-colors hover:bg-bg-hover",
                  needsYou
                    ? "border-warning/40 hover:border-warning/60"
                    : "border-border hover:border-border-strong",
                )}
              >
                <StatusDot terminal={t} className="mt-0.5 -ml-1" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium truncate">{t.title}</div>
                  <div className="flex items-center gap-2 text-[10px] text-text-muted mt-0.5 min-w-0">
                    <span className="font-mono truncate">{dirTail(t.dir)}</span>
                    {hosts.length > 1 && (
                      <span className="flex items-center gap-0.5 shrink-0">
                        <Server className="w-2.5 h-2.5" />
                        {hostName.get(t.hostId) ?? "?"}
                      </span>
                    )}
                    {t.lastActivityAt && (
                      <span className="shrink-0 ml-auto">
                        {formatRelativeTime(t.lastActivityAt)}
                      </span>
                    )}
                  </div>
                  {needsYou && (
                    <div className="text-[10px] text-warning truncate mt-0.5">
                      {attentionLabel(t.attentionReason)}
                    </div>
                  )}
                  {links.length > 0 && (
                    <WorkLinkBadges links={links} size="xs" max={2} className="mt-1" />
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
