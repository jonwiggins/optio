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
import { SESSION_DOT, sessionTone } from "./attention";
import { useRailStore } from "./rail-store";
import { useLocalFeed } from "./local-feed";
import { useBellStore } from "./bell-store";
import { collectWorkLinks, WorkLinkBadges, workLinksSearchText } from "./work-links";
import { addToSplit, parseSplit, splitHref, MAX_PANES } from "./split-state";
import { nextNeedsYou, orderSessions } from "./session-order";
import { inputClass } from "@/components/ui/input";

/**
 * Session rail: replaces the app sidebar while you're inside a terminal
 * (/local/:id) so jumping between many sessions is one click or one
 * keystroke. Ordered by when you last typed into a session (else when it
 * was made), live above Finished, so rows stay put while agents flip
 * between working and needs-you; searchable by title, dir, host, or the
 * PR / ticket the session is working on.
 *
 * Keyboard (captured before xterm sees it):
 *   Ctrl/⌘ + Shift + ↑ / ↓   previous / next session in rail order
 *   Ctrl/⌘ + Shift + ↵       jump to the next "needs you" session (rail order)
 *
 * Split view: the row's ⧉ button (or Shift+click) opens a session beside the
 * current one; the extra panes ride along in ?split= as you switch primaries.
 */

type Group = { key: string; label: string; tone: string; items: any[] };

function dotFor(t: any): string {
  // The shared session scale (see attention.ts): purple working, yellow
  // needs you, green completed, grey dead/idle.
  return SESSION_DOT[sessionTone(t)];
}

/**
 * Live sessions, then Finished — each in the stable order of
 * session-order.ts. Attention never regroups rows (that made them jump
 * under the pointer); it shows on the row and in the header count.
 */
function groupTerminals(terminals: any[]): Group[] {
  const { live, finished } = orderSessions(terminals);
  return [
    { key: "live", label: "Live", tone: "text-text-muted", items: live },
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
  const ordered = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const order = useMemo(() => ordered.map((t) => t.id), [ordered]);

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
        const target = nextNeedsYou(ordered, activeId);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        go(target.id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [order, ordered, activeId, go]);

  // Keep the active row in view when switching by keyboard.
  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-terminal-id="${activeId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId, groups]);

  // Every session waiting on you, live or just finished, across the
  // unfiltered list — the header count is how you find them now.
  const needsYouCount = useMemo(
    () => terminals.filter((t) => t.attentionState === "needs_you").length,
    [terminals],
  );
  const jumpToNeedsYou = () => {
    const target = nextNeedsYou(ordered, activeId);
    if (target) go(target.id);
  };
  const armed = useBellStore((s) => s.armed);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 pt-3 pb-2 border-b border-border/50">
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/work"
            onClick={onNavigate}
            className="flex items-center gap-1.5 text-[13px] font-medium text-text-muted hover:text-text transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Work
          </Link>
          <div className="flex items-center gap-1">
            <Link
              href="/work/new"
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
            className={inputClass({ size: "sm", className: "pl-7 pr-2" })}
          />
        </div>
        {needsYouCount > 0 && (
          <button
            type="button"
            onClick={jumpToNeedsYou}
            title="Jump to the next session that needs you (⌃⇧↵)"
            data-testid="rail-needs-you"
            className="mt-2 w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium text-warning bg-warning/10 hover:bg-warning/15 transition-colors"
          >
            <Zap className="w-3 h-3" />
            {needsYouCount} need{needsYouCount === 1 ? "s" : ""} you
            <span className="ml-auto font-mono opacity-70">⌃⇧↵</span>
          </button>
        )}
      </div>

      <div
        ref={listRef}
        role="region"
        aria-label="Sessions"
        tabIndex={0}
        className="session-rail-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain py-1.5"
      >
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
