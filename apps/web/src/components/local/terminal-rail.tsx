"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  ArrowLeft,
  BellRing,
  Columns2,
  PanelLeftClose,
  Plus,
  Search,
  Server,
  Zap,
} from "lucide-react";
import { attentionLabel, dirTail } from "./terminal-card";
import { useRailStore } from "./rail-store";
import { useLocalFeed } from "./local-feed";
import { useBellStore } from "./bell-store";
import { collectWorkLinks, WorkLinkBadges, workLinksSearchText } from "./work-links";
import { addToSplit, parseSplit, splitHref, MAX_PANES } from "./split-state";

/**
 * Session rail: replaces the app sidebar while you're inside a terminal
 * (/local/:id) so jumping between many sessions is one click or one
 * keystroke. Grouped by what matters — needs you first — and searchable
 * by title, dir, host, or the PR / ticket the session is working on.
 *
 * Keyboard (captured before xterm sees it):
 *   Ctrl/⌘ + Shift + ↑ / ↓   previous / next session in rail order
 *   Ctrl/⌘ + Shift + ↵       jump to the oldest "needs you" session
 *
 * Split view: the row's ⧉ button (or Shift+click) opens a session beside the
 * current one; the extra panes ride along in ?split= as you switch primaries.
 */

type Group = { key: string; label: string; tone: string; items: any[] };

// Same scheme as the favicon dot: yellow needs you, green working, grey quiet.
const DOT: Record<string, string> = {
  needs_you: "bg-warning",
  working: "bg-success",
  idle: "bg-text-muted/40",
  dead: "bg-text-muted/25",
  pending: "bg-warning/60",
};

function dotFor(t: any): string {
  if (t.state === "exited" || t.state === "error") {
    return t.attentionState === "needs_you" ? DOT.needs_you : DOT.dead;
  }
  if (t.state === "pending" || t.state === "launching") return DOT.pending;
  return DOT[t.attentionState] ?? DOT.idle;
}

function groupTerminals(terminals: any[]): Group[] {
  const byTime = (a: any, b: any) =>
    new Date(b.lastActivityAt ?? b.updatedAt).getTime() -
    new Date(a.lastActivityAt ?? a.updatedAt).getTime();
  const needsYou = terminals
    .filter((t) => t.attentionState === "needs_you")
    // Oldest wait first — the one you've kept waiting longest is on top.
    .sort((a, b) => -byTime(a, b));
  const live = (t: any) => t.state === "running" || t.state === "launching";
  const working = terminals
    .filter((t) => t.attentionState !== "needs_you" && live(t) && t.attentionState === "working")
    .sort(byTime);
  const idle = terminals
    .filter(
      (t) =>
        t.attentionState !== "needs_you" &&
        ((live(t) && t.attentionState !== "working") || t.state === "pending"),
    )
    .sort(byTime);
  const finished = terminals
    .filter(
      (t) => t.attentionState !== "needs_you" && (t.state === "exited" || t.state === "error"),
    )
    .sort(byTime);
  return [
    { key: "needs_you", label: "Needs you", tone: "text-warning", items: needsYou },
    { key: "working", label: "Working", tone: "text-success", items: working },
    { key: "idle", label: "Idle", tone: "text-text-muted", items: idle },
    { key: "finished", label: "Finished", tone: "text-text-muted/70", items: finished },
  ].filter((g) => g.items.length > 0);
}

export function TerminalRail({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const activeId = pathname.startsWith("/local/") ? pathname.slice("/local/".length) : null;
  const searchParams = useSearchParams();
  const splitState = useMemo(
    () => parseSplit(searchParams, activeId ?? undefined),
    [searchParams, activeId],
  );
  const shown = useMemo(
    () => new Set(activeId ? [activeId, ...splitState.split] : []),
    [activeId, splitState],
  );

  const { terminals, hosts } = useLocalFeed();
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const hostName = useMemo(() => new Map(hosts.map((h) => [h.id, h.name])), [hosts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return terminals;
    return terminals.filter((t) =>
      `${t.title} ${t.dir} ${hostName.get(t.hostId) ?? ""} ${workLinksSearchText(collectWorkLinks(t))}`
        .toLowerCase()
        .includes(q),
    );
  }, [terminals, search, hostName]);

  const groups = useMemo(() => groupTerminals(filtered), [filtered]);
  const order = useMemo(() => groups.flatMap((g) => g.items.map((t) => t.id)), [groups]);

  const go = useCallback(
    (id: string, opts: { split?: boolean } = {}) => {
      if (opts.split && activeId && id !== activeId) {
        // Open beside the current primary.
        router.push(splitHref(activeId, addToSplit(activeId, splitState, id), splitState.layout));
      } else {
        // Switch primary; panes already open stay open (minus the new primary).
        router.push(splitHref(id, splitState.split, splitState.layout));
      }
      onNavigate?.();
    },
    [router, onNavigate, activeId, splitState],
  );

  // Keyboard switching. Capture phase on window so it wins over xterm's
  // textarea, which otherwise eats every keystroke while focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (order.length === 0) return;
        const idx = activeId ? order.indexOf(activeId) : -1;
        const next =
          e.key === "ArrowDown"
            ? order[(idx + 1) % order.length]
            : order[(idx - 1 + order.length) % order.length];
        e.preventDefault();
        e.stopPropagation();
        go(next);
      } else if (e.key === "Enter") {
        const target = groups.find((g) => g.key === "needs_you")?.items[0];
        if (!target || target.id === activeId) return;
        e.preventDefault();
        e.stopPropagation();
        go(target.id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [order, groups, activeId, go]);

  // Keep the active row in view when switching by keyboard.
  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-terminal-id="${activeId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId, groups]);

  const needsYouCount = groups.find((g) => g.key === "needs_you")?.items.length ?? 0;
  const armed = useBellStore((s) => s.armed);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 pt-3 pb-2 border-b border-border/50">
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/local"
            onClick={onNavigate}
            className="flex items-center gap-1.5 text-[13px] font-medium text-text-muted hover:text-text transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Local
          </Link>
          <div className="flex items-center gap-1">
            <Link
              href="/local?new=1"
              onClick={onNavigate}
              title="New terminal"
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              <Plus className="w-3 h-3" />
              New
            </Link>
            <button
              type="button"
              onClick={() => useRailStore.getState().setCollapsed(true)}
              title="Hide sessions (⌃⇧B)"
              aria-label="Hide sessions"
              className="hidden md:inline-flex p-1 rounded-md text-text-muted hover:text-text hover:bg-bg-hover/60 transition-colors"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <div className="relative mt-2">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Title, dir, PR, ticket…"
            aria-label="Search sessions"
            className="w-full pl-7 pr-2 py-1.5 rounded-md bg-bg border border-border text-xs focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto py-1.5">
        {groups.length === 0 && (
          <div className="px-3 py-6 text-xs text-text-muted text-center">
            {terminals.length === 0 ? "No sessions yet." : "Nothing matches."}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key} className="mb-2">
            <div
              className={cn(
                "px-3 pt-2 pb-1 text-[10px] font-semibold tracking-widest uppercase flex items-center gap-1.5",
                g.tone,
              )}
            >
              {g.key === "needs_you" && <Zap className="w-3 h-3" />}
              {g.label}
              <span className="opacity-60 font-normal">{g.items.length}</span>
            </div>
            <div className="px-1.5 space-y-px">
              {g.items.map((t) => {
                const active = t.id === activeId;
                const links = collectWorkLinks(t);
                const inSplit = !active && shown.has(t.id);
                const canSplit = !!activeId && !shown.has(t.id);
                return (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    data-terminal-id={t.id}
                    onClick={(e) => go(t.id, { split: e.shiftKey })}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        go(t.id, { split: e.shiftKey });
                      }
                    }}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative w-full text-left px-2 py-1.5 rounded-md transition-colors group cursor-pointer",
                      active
                        ? "text-text-heading nav-active"
                        : inSplit
                          ? "bg-primary/5 text-text"
                          : "text-text-muted hover:bg-bg-hover/60 hover:text-text",
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0 pr-6">
                      <span
                        className={cn(
                          "w-1.5 h-1.5 rounded-full shrink-0",
                          dotFor(t),
                          t.attentionState === "needs_you" && "animate-pulse",
                        )}
                      />
                      <span
                        className={cn(
                          "text-[13px] truncate",
                          active ? "font-medium" : "font-normal",
                        )}
                      >
                        {t.title}
                      </span>
                      {inSplit && (
                        <Columns2
                          className="w-3 h-3 text-primary shrink-0"
                          aria-label="Open in a split pane"
                        />
                      )}
                      {armed.includes(t.id) && (
                        <BellRing
                          className="w-3 h-3 text-warning/80 shrink-0"
                          aria-label="Will ping you when it needs you"
                        />
                      )}
                    </div>
                    {canSplit && shown.size < MAX_PANES && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          go(t.id, { split: true });
                        }}
                        title="Open side by side (Shift+click)"
                        aria-label={`Open ${t.title} side by side`}
                        className="absolute right-1.5 top-1.5 p-1 rounded text-text-muted/70 hover:text-primary hover:bg-primary/10 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 transition-opacity"
                      >
                        <Columns2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <div className="flex items-center gap-1.5 mt-0.5 pl-3.5 text-[10px] text-text-muted/80 min-w-0">
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
                    {t.attentionState === "needs_you" && (
                      <div className="pl-3.5 mt-0.5 text-[10px] text-warning truncate">
                        {attentionLabel(t.attentionReason)}
                      </div>
                    )}
                    {links.length > 0 && (
                      <WorkLinkBadges links={links} size="xs" max={2} className="pl-3.5 mt-1" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="px-3 py-2 border-t border-border/50 text-[10px] text-text-muted/60 leading-4">
        <div>
          <kbd className="font-mono">⌃⇧↑↓</kbd> switch session
        </div>
        <div>
          <kbd className="font-mono">⌃⇧↵</kbd> next needs you
          {needsYouCount > 0 ? ` (${needsYouCount})` : ""}
        </div>
        <div>
          <kbd className="font-mono">⇧click</kbd> open side by side
        </div>
        <div className="hidden md:block">
          <kbd className="font-mono">⌃⇧B</kbd> hide sessions
        </div>
      </div>
    </div>
  );
}
