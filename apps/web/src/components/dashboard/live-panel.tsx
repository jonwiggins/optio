import Link from "next/link";
import { Bot, FolderGit2, Laptop, Plus, Radio, Server, Terminal } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { StatusDot, attentionLabel, dirTail } from "@/components/local/terminal-card";
import { collectWorkLinks, WorkLinkBadges } from "@/components/local/work-links";

export interface LiveItem {
  key: string;
  kind: "local" | "session" | "agent";
  href: string;
  title: string;
  /** Second line: dir, repo, or agent slug. */
  where: string | null;
  hostName: string | null;
  /** Local terminals carry their whole row for the StatusDot + badges. */
  terminal?: any;
  /** Non-local: a single-color pulse. */
  tone?: "working" | "idle" | "needs_you";
  reason?: string | null;
  since: string | null;
}

/** Merge everything live into one list: needs-you first, then most recent. */
export function collectLive(
  localTerminals: any[],
  hosts: any[],
  sessions: any[],
  agents: any[],
): LiveItem[] {
  const hostName = new Map(hosts.map((h) => [h.id, h.name]));
  const items: LiveItem[] = [];
  for (const t of localTerminals) {
    if (!["pending", "launching", "running"].includes(t.state)) continue;
    items.push({
      key: `local-${t.id}`,
      kind: "local",
      href: `/local/${t.id}`,
      title: t.title,
      where: dirTail(t.dir),
      hostName: hosts.length > 1 ? (hostName.get(t.hostId) ?? null) : null,
      terminal: t,
      tone: t.attentionState,
      reason: t.attentionState === "needs_you" ? attentionLabel(t.attentionReason) : null,
      since: t.lastActivityAt ?? t.updatedAt ?? null,
    });
  }
  for (const s of sessions) {
    items.push({
      key: `session-${s.id}`,
      kind: "session",
      href: `/sessions/${s.id}`,
      title: s.branch ?? `Session ${String(s.id).slice(0, 8)}`,
      where: s.repoUrl ? s.repoUrl.replace(/^https?:\/\/[^/]+\//, "") : null,
      hostName: null,
      tone: "working",
      since: s.lastActivityAt ?? s.createdAt ?? null,
    });
  }
  for (const a of agents) {
    if (!["running", "queued", "provisioning", "paused"].includes(a.state)) continue;
    items.push({
      key: `agent-${a.id}`,
      kind: "agent",
      href: `/agents/${a.id}`,
      title: a.name,
      where: a.slug ? `@${a.slug}` : null,
      hostName: null,
      tone: a.state === "paused" ? "needs_you" : a.state === "running" ? "working" : "idle",
      reason: a.state === "paused" ? "paused" : a.state === "queued" ? "queued" : null,
      since: a.lastActivityAt ?? a.updatedAt ?? null,
    });
  }
  const rank = (i: LiveItem) => (i.tone === "needs_you" ? 0 : i.tone === "working" ? 1 : 2);
  return items.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const at = a.since ? new Date(a.since).getTime() : 0;
    const bt = b.since ? new Date(b.since).getTime() : 0;
    // Waiting items: the one you've kept waiting longest first. Otherwise newest first.
    return rank(a) === 0 ? at - bt : bt - at;
  });
}

const KIND_ICON = { local: Laptop, session: Terminal, agent: Bot } as const;
const TONE_DOT = {
  needs_you: "bg-warning animate-pulse",
  working: "bg-success",
  idle: "bg-text-muted/40",
} as const;

/**
 * The overview's "Live" panel: every open terminal, session, and awake
 * agent in one place, each linking into its own view.
 */
export function LivePanel({ items, max = 9 }: { items: LiveItem[]; max?: number }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-text-heading flex items-center gap-2">
          <Radio className="w-4 h-4 text-success" />
          Live
          <span className="text-xs font-normal text-success bg-success/10 px-1.5 py-0.5 rounded-md">
            {items.length}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <Link
            href="/local?new=1"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> New terminal
          </Link>
          <Link href="/local" className="text-xs text-primary hover:underline">
            Local &rarr;
          </Link>
          <Link href="/sessions" className="text-xs text-primary hover:underline">
            Sessions &rarr;
          </Link>
        </div>
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
        {shown.map((item) => {
          const Icon = KIND_ICON[item.kind];
          const needsYou = item.tone === "needs_you";
          const links = item.terminal ? collectWorkLinks(item.terminal) : [];
          return (
            <Link
              key={item.key}
              href={item.href}
              className={cn(
                "flex items-start gap-2.5 p-3 rounded-lg border bg-bg-card transition-colors hover:bg-bg-hover",
                needsYou
                  ? "border-warning/40 hover:border-warning/60"
                  : "border-border hover:border-border-strong",
              )}
            >
              {item.terminal ? (
                <StatusDot terminal={item.terminal} className="mt-0.5 -ml-1" />
              ) : (
                <span className="inline-flex items-center justify-center w-5 h-5 mt-0.5 -ml-1 shrink-0">
                  <span className={cn("w-2 h-2 rounded-full", TONE_DOT[item.tone ?? "idle"])} />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Icon className="w-3 h-3 text-text-muted/70 shrink-0" />
                  <span className="text-xs font-medium truncate">{item.title}</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-text-muted mt-0.5 min-w-0">
                  {item.where && (
                    <span className="flex items-center gap-0.5 min-w-0">
                      {item.kind === "session" && <FolderGit2 className="w-2.5 h-2.5 shrink-0" />}
                      <span className="font-mono truncate">{item.where}</span>
                    </span>
                  )}
                  {item.hostName && (
                    <span className="flex items-center gap-0.5 shrink-0">
                      <Server className="w-2.5 h-2.5" />
                      {item.hostName}
                    </span>
                  )}
                  {item.since && (
                    <span className="shrink-0 ml-auto tabular-nums">
                      {formatRelativeTime(item.since)}
                    </span>
                  )}
                </div>
                {item.reason && (
                  <div className="text-[10px] text-warning truncate mt-0.5">{item.reason}</div>
                )}
                {links.length > 0 && (
                  <WorkLinkBadges links={links} size="xs" max={2} className="mt-1" />
                )}
              </div>
            </Link>
          );
        })}
      </div>
      {rest > 0 && (
        <div className="text-[11px] text-text-muted mt-2 px-1">
          +{rest} more —{" "}
          <Link href="/local" className="text-primary hover:underline">
            see Local
          </Link>
        </div>
      )}
    </div>
  );
}
