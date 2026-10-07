"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn, formatRelativeTime } from "@/lib/utils";
import { api } from "@/lib/api-client";
import {
  ArrowLeft,
  BellRing,
  Columns2,
  Keyboard,
  ChevronDown,
  X,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  Laptop,
  Zap,
} from "lucide-react";
import { attentionLabel, dirTail, SpawnSourceBadge } from "./terminal-card";
import { SESSION_DOT, sessionTone } from "./attention";
import { useRailStore } from "./rail-store";
import { useLocalFeed } from "./local-feed";
import { useBellStore } from "./bell-store";
import { collectWorkLinks, WorkLinkBadges, workLinksSearchText } from "./work-links";
import { addToSplit, parseSplit, splitHref, MAX_PANES } from "./split-state";
import { nextNeedsYou, orderSessions } from "./session-order";
import { inputClass } from "@/components/ui/input";
import { LocalSessionIcon } from "./session-icon";
import { SessionRailScroll } from "./session-rail-scroll";
import { IfCanMutate } from "@/components/role-gate";

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
  // The shared session scale: purple working, green needs-you, grey finished/idle.
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

  const { terminals: feedTerminals, hosts } = useLocalFeed();
  // A pin toggles the row's place at once; the feed's next refresh agrees.
  const [pinOverride, setPinOverride] = useState<Record<string, string | null>>({});
  const terminals = useMemo(
    () =>
      feedTerminals.map((t: any) =>
        t.id in pinOverride ? { ...t, pinnedAt: pinOverride[t.id] } : t,
      ),
    [feedTerminals, pinOverride],
  );
  useEffect(() => {
    setPinOverride((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(prev)) {
        const row = feedTerminals.find((t: any) => t.id === id);
        if (!row || !!row.pinnedAt === !!prev[id]) delete next[id];
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [feedTerminals]);
  const togglePin = useCallback(async (t: any) => {
    const pin = !t.pinnedAt;
    setPinOverride((prev) => ({ ...prev, [t.id]: pin ? new Date().toISOString() : null }));
    try {
      if (pin) await api.pinLocalTerminal(t.id);
      else await api.unpinLocalTerminal(t.id);
    } catch {
      setPinOverride((prev) => {
        const next = { ...prev };
        delete next[t.id];
        return next;
      });
    }
  }, []);
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

  const splitChildren = useMemo(
    () => splitState.split.map((id) => terminals.find((t) => t.id === id)).filter(Boolean),
    [splitState.split, terminals],
  );
  const groups = useMemo(() => {
    const parent = terminals.find((t) => t.id === activeId);
    const roots = filtered.filter((t) => !splitState.split.includes(t.id));
    if (
      parent &&
      !roots.includes(parent) &&
      filtered.some((t) => splitState.split.includes(t.id))
    ) {
      roots.unshift(parent);
    }
    return groupTerminals(roots);
  }, [filtered, terminals, activeId, splitState.split]);
  const ordered = useMemo(
    () =>
      groups.flatMap((g) =>
        g.items.flatMap((t) => (t.id === activeId ? [t, ...splitChildren] : [t])),
      ),
    [groups, activeId, splitChildren],
  );
  const order = useMemo(() => ordered.map((t) => t.id), [ordered]);

  const go = useCallback(
    (id: string, opts: { split?: boolean } = {}) => {
      if (opts.split && activeId && id !== activeId) {
        if (shown.size >= MAX_PANES) return;
        router.push(splitHref(activeId, addToSplit(activeId, splitState, id), splitState.layout));
      } else if (shown.has(id)) {
        const pane = document.querySelector<HTMLElement>(`[data-session-pane="${id}"]`);
        pane?.scrollIntoView({ block: "nearest" });
        pane?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      } else {
        router.push(splitHref(id, [], splitState.layout));
      }
      onNavigate?.();
    },
    [router, onNavigate, activeId, splitState, shown],
  );

  // Keyboard switching. Capture phase on window so it wins over xterm's
  // textarea, which otherwise eats every keystroke while focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (order.length === 0) return;
        const focusedId =
          document.activeElement?.closest<HTMLElement>("[data-session-pane]")?.dataset
            .sessionPane ?? activeId;
        const idx = focusedId ? order.indexOf(focusedId) : -1;
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
    <div className="flex flex-col h-full min-h-0 bg-bg-card/30">
      <div className="shrink-0 px-3 pt-3 pb-3 border-b border-border/60">
        <div className="flex items-center justify-between gap-2">
          <Link
            href="/work"
            onClick={onNavigate}
            className="flex items-center gap-1.5 text-xs font-medium text-text-muted hover:text-text transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Work
          </Link>
          <div className="flex items-center gap-1">
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
        <div className="mt-4 mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight text-text-heading">Sessions</h2>
            <span className="rounded-md bg-bg-hover px-1.5 py-0.5 text-[11px] tabular-nums text-text-muted">
              {terminals.length}
            </span>
          </div>
          <IfCanMutate>
            <Link
              href="/work/new"
              onClick={onNavigate}
              title="New session"
              aria-label="New session"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary transition-colors hover:bg-primary/20"
            >
              <Plus className="h-4 w-4" />
            </Link>
          </IfCanMutate>
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sessions…"
            aria-label="Search sessions"
            className={inputClass({ size: "sm", className: "pl-7 pr-2 rounded-lg bg-bg/60" })}
          />
        </div>
        {needsYouCount > 0 && (
          <button
            type="button"
            onClick={jumpToNeedsYou}
            title="Jump to the next session that needs you (⌃⇧↵)"
            data-testid="rail-needs-you"
            className="mt-2.5 w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[11px] font-medium text-success bg-success/10 hover:bg-success/15 transition-colors"
          >
            <Zap className="w-3 h-3" />
            {needsYouCount} need{needsYouCount === 1 ? "s" : ""} you
            <span className="ml-auto font-mono opacity-70">⌃⇧↵</span>
          </button>
        )}
      </div>

      <SessionRailScroll viewportRef={listRef} className="py-1.5">
        {groups.length === 0 && (
          <div className="px-3 py-6 text-xs text-text-muted text-center">
            {terminals.length === 0 ? "No sessions yet." : "Nothing matches."}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key} className="mb-2">
            <div
              className={cn(
                "px-3 pt-3 pb-2 text-[10px] font-semibold tracking-widest uppercase flex items-center gap-2",
                g.tone,
              )}
            >
              {g.label}
              <span className="ml-auto text-[10px] tracking-normal tabular-nums opacity-60 font-normal">
                {g.items.length}
              </span>
            </div>
            <div className="px-1.5 space-y-1">
              {g.items.map((t) => {
                const active = t.id === activeId;
                const links = collectWorkLinks(t);
                const inSplit = !active && shown.has(t.id);
                const canSplit = !!activeId && !shown.has(t.id);
                return (
                  <div
                    key={t.id}
                    data-session-group={active && splitChildren.length ? t.id : undefined}
                  >
                    <div
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
                        "relative w-full text-left px-2.5 py-2.5 rounded-xl border transition-colors group cursor-pointer",
                        active
                          ? "text-text-heading border-primary/25 bg-primary/10 shadow-sm"
                          : inSplit
                            ? "border-primary/10 bg-primary/5 text-text"
                            : "border-transparent text-text-muted hover:bg-bg-hover/60 hover:text-text",
                      )}
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        <span className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center">
                          <LocalSessionIcon terminal={t} className="h-6 w-6" />
                          <span
                            className={cn(
                              "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-bg-card",
                              dotFor(t),
                              t.attentionState === "needs_you" && "animate-pulse",
                            )}
                          />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5 pr-12">
                            <span className="truncate text-[13px] font-medium">{t.title}</span>
                            <SpawnSourceBadge
                              spawnedBy={t.spawnedBy}
                              triggerType={t.triggerType}
                              ticketSource={t.ticketSource}
                              compact
                              colored
                            />
                            {inSplit && (
                              <Columns2
                                className="h-3 w-3 shrink-0 text-primary"
                                aria-label="Open in a split pane"
                              />
                            )}
                            {armed.includes(t.id) && (
                              <BellRing
                                className="h-3 w-3 shrink-0 text-success/80"
                                aria-label="Will ping you when it needs you"
                              />
                            )}
                          </div>
                          <div
                            className="mt-0.5 truncate font-mono text-[10px] text-text-muted/80"
                            title={t.dir}
                          >
                            {dirTail(t.dir)}
                          </div>
                        </div>
                      </div>
                      <div className="absolute right-1.5 top-2.5 flex items-center gap-0.5">
                        {canSplit && shown.size < MAX_PANES && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              go(t.id, { split: true });
                            }}
                            title="Open side by side (Shift+click)"
                            aria-label={`Open ${t.title} side by side`}
                            className="p-1 rounded-md text-text-muted/70 hover:text-primary hover:bg-primary/10 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 transition-opacity"
                          >
                            <Columns2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void togglePin(t);
                          }}
                          title={t.pinnedAt ? "Unpin" : "Pin to the top"}
                          aria-label={t.pinnedAt ? `Unpin ${t.title}` : `Pin ${t.title} to the top`}
                          aria-pressed={!!t.pinnedAt}
                          data-testid={`session-pin-${t.id}`}
                          className={cn(
                            "p-1 rounded-md transition-opacity",
                            t.pinnedAt
                              ? "text-text-heading hover:text-text-heading/80"
                              : "text-text-muted/70 hover:text-primary hover:bg-primary/10 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100",
                          )}
                        >
                          <Pin className={cn("w-3.5 h-3.5", t.pinnedAt && "fill-current")} />
                        </button>
                      </div>
                      <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[10px] text-text-muted/70">
                        <span
                          className="flex min-w-0 flex-1 items-center gap-1"
                          title={hostName.get(t.hostId)}
                        >
                          <Laptop className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate">{hostName.get(t.hostId) ?? "Machine"}</span>
                        </span>
                        {t.lastActivityAt && (
                          <span className="shrink-0 tabular-nums">
                            {formatRelativeTime(t.lastActivityAt)}
                          </span>
                        )}
                      </div>
                      {t.attentionState === "needs_you" && (
                        <div className="mt-1.5 text-[10px] text-success truncate">
                          {attentionLabel(t.attentionReason)}
                        </div>
                      )}
                      {links.length > 0 && (
                        <WorkLinkBadges links={links} size="xs" max={2} className="mt-1.5" />
                      )}
                    </div>
                    {active && splitChildren.length > 0 && (
                      <div
                        className="ml-5 mr-1 mt-1 mb-2 border-l border-primary/25 pl-2"
                        aria-label="Grouped sessions"
                      >
                        {splitChildren.map((child) => (
                          <div
                            key={child.id}
                            data-terminal-id={child.id}
                            className="group/child flex min-w-0 items-center rounded-md hover:bg-bg-hover/60"
                          >
                            <button
                              type="button"
                              onClick={() => go(child.id)}
                              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs text-text-muted hover:text-text"
                              title={`Focus ${child.title}`}
                            >
                              <LocalSessionIcon terminal={child} className="h-4 w-4" />
                              <span className="truncate">{child.title}</span>
                              <SpawnSourceBadge
                                spawnedBy={child.spawnedBy}
                                triggerType={child.triggerType}
                                ticketSource={child.ticketSource}
                                compact
                                colored
                              />
                              <span
                                className={cn(
                                  "ml-auto h-1.5 w-1.5 shrink-0 rounded-full",
                                  dotFor(child),
                                )}
                              />
                            </button>
                            <button
                              type="button"
                              aria-label={`Ungroup ${child.title}`}
                              title="Remove from this view; keep the session running"
                              onClick={() =>
                                router.replace(
                                  splitHref(
                                    activeId!,
                                    splitState.split.filter((id) => id !== child.id),
                                    splitState.layout,
                                  ),
                                )
                              }
                              className="shrink-0 rounded p-1 text-text-muted/60 hover:text-text md:opacity-0 md:group-hover/child:opacity-100 focus:opacity-100"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </SessionRailScroll>

      <details className="shrink-0 border-t border-border/60 px-3 py-2.5 text-[10px] text-text-muted/70 group/shortcuts">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded text-[11px] hover:text-text [&::-webkit-details-marker]:hidden">
          <Keyboard className="h-3.5 w-3.5" />
          Keyboard shortcuts
          <ChevronDown className="ml-auto h-3 w-3 transition-transform group-open/shortcuts:rotate-180" />
        </summary>
        <div className="mt-2 space-y-1.5">
          <div className="flex justify-between gap-2">
            <span>Switch session</span>
            <kbd className="font-mono">⌃⇧↑↓</kbd>
          </div>
          <div className="flex justify-between gap-2">
            <span>Next needs you</span>
            <kbd className="font-mono">⌃⇧↵</kbd>
          </div>
          <div className="flex justify-between gap-2">
            <span>Open side by side</span>
            <kbd className="font-mono">⇧click</kbd>
          </div>
          <div className="hidden md:flex justify-between gap-2">
            <span>Hide sessions</span>
            <kbd className="font-mono">⌃⇧B</kbd>
          </div>
        </div>
      </details>
    </div>
  );
}
