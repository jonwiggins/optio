"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Bell,
  BellRing,
  Columns2,
  Loader2,
  Maximize2,
  PanelLeftOpen,
  Play,
  Rows2,
  Server,
  Terminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { LocalStateBadge, SpawnSourceBadge, attentionLabel, dirTail } from "./terminal-card";
import { ErrorBoundary } from "@/components/error-boundary";
import { collectWorkLinks, WorkLinkBadges } from "./work-links";
import type { SplitLayout } from "./split-state";
import { useRailStore } from "./rail-store";
import { useBellStore } from "./bell-store";
import { ensureNotificationPermission } from "./attention-watcher";
import { CONN_DOT, CONN_LABEL, type ConnState } from "./conn-state";

const LocalTerminal = dynamic(() => import("./local-terminal").then((m) => m.LocalTerminal), {
  ssr: false,
  loading: () => (
    <div className="h-full bg-[#09090b] flex items-center justify-center text-text-muted text-sm">
      Loading terminal...
    </div>
  ),
});

export interface PaneChrome {
  /** Number of panes on screen; the layout toggle appears above 1. */
  paneCount: number;
  layout: SplitLayout;
  onLayout: (layout: SplitLayout) => void;
  /** Extra panes only: drop this pane / swap it into the primary slot. */
  onClose?: () => void;
  onFocus?: () => void;
}

/**
 * One terminal with its own data, actions, and xterm stream. `variant`
 * picks the chrome: the primary pane carries the full page header, extra
 * split panes get a one-line strip so the terminal keeps the room.
 */
export function TerminalPane({
  terminalId,
  variant,
  hosts,
  chrome,
  onDeleted,
  onTitle,
}: {
  terminalId: string;
  variant: "primary" | "split";
  hosts: any[];
  chrome: PaneChrome;
  /** Primary pane: navigate away after a delete. */
  onDeleted?: () => void;
  onTitle?: (title: string) => void;
}) {
  const [terminal, setTerminal] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const railCollapsed = useRailStore((s) => s.collapsed);
  const bellArmed = useBellStore((s) => s.armed.includes(terminalId));

  const toggleBell = async () => {
    if (bellArmed) {
      useBellStore.getState().setArmed(terminalId, false);
      return;
    }
    const perm = await ensureNotificationPermission();
    if (perm === "unsupported") {
      toast.error("This browser can't show notifications");
      return;
    }
    if (perm === "denied") {
      toast.error(
        "Notifications are blocked for this site — allow them in the browser's site settings",
      );
      return;
    }
    useBellStore.getState().setArmed(terminalId, true);
    toast.success("You'll be pinged when this session needs you");
  };

  const fetchTerminal = useCallback(async () => {
    try {
      const res = await api.getLocalTerminal(terminalId);
      setTerminal(res.terminal);
      onTitle?.(res.terminal.title);
      return res.terminal;
    } catch {
      return null;
    }
  }, [terminalId, onTitle]);

  useEffect(() => {
    setLoading(true);
    fetchTerminal().finally(() => setLoading(false));
  }, [fetchTerminal]);

  // Poll as a fallback — the stream WS pushes status while attached.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchTerminal();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchTerminal]);

  const host = terminal ? hosts.find((h) => h.id === terminal.hostId) : null;

  const handleStart = async () => {
    setBusy(true);
    try {
      const res = await api.startLocalTerminal(terminalId);
      setTerminal(res.terminal);
      toast.success("Starting terminal…");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start terminal");
    }
    setBusy(false);
  };

  const handleKill = async () => {
    if (!confirm("Kill this terminal's process?")) return;
    setBusy(true);
    try {
      await api.killLocalTerminal(terminalId);
      toast.success("Kill signal sent");
      fetchTerminal();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to kill terminal");
    }
    setBusy(false);
  };

  const handleDelete = async () => {
    if (!confirm(`Delete terminal "${terminal?.title}"?`)) return;
    setBusy(true);
    try {
      await api.deleteLocalTerminal(terminalId);
      toast.success("Terminal deleted");
      if (variant === "primary") onDeleted?.();
      else chrome.onClose?.();
      return;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete terminal");
    }
    setBusy(false);
  };

  const handleStatus = useCallback((state: string, attentionState: string) => {
    setTerminal((prev: any) => (prev ? { ...prev, state, attentionState } : prev));
  }, []);

  const handleExit = useCallback(
    (exitCode: number | null) => {
      setTerminal((prev: any) =>
        prev && prev.state !== "exited" && prev.state !== "error"
          ? { ...prev, state: "exited", exitCode }
          : prev,
      );
      fetchTerminal();
    },
    [fetchTerminal],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading terminal...
      </div>
    );
  }

  if (!terminal) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3">
        <Terminal className="w-8 h-8 opacity-30" />
        <p className="text-sm">Terminal not found</p>
        {variant === "primary" ? (
          <Link href="/local" className="text-xs text-primary hover:underline">
            Back to Local
          </Link>
        ) : (
          <button onClick={chrome.onClose} className="text-xs text-primary hover:underline">
            Close pane
          </button>
        )}
      </div>
    );
  }

  // Parked-on-offline-host terminals spawn themselves on reconnect; Start
  // would only 409.
  const canStart = terminal.state === "pending" && terminal.pendingReason !== "host_offline";
  const canKill = terminal.state === "running" || terminal.state === "launching";
  const canDelete =
    terminal.state === "exited" || terminal.state === "error" || terminal.state === "pending";
  const isDead = terminal.state === "exited" || terminal.state === "error";
  const links = collectWorkLinks(terminal);

  const layoutToggle = chrome.paneCount > 1 && (
    <div
      className="hidden md:flex items-center p-0.5 rounded-md bg-bg-card border border-border"
      role="radiogroup"
      aria-label="Split layout"
    >
      {(
        [
          ["cols", Columns2, "Side by side"],
          ["rows", Rows2, "Stacked"],
        ] as Array<[SplitLayout, typeof Columns2, string]>
      ).map(([value, Icon, label]) => (
        <button
          key={value}
          role="radio"
          aria-checked={chrome.layout === value}
          aria-label={label}
          title={label}
          onClick={() => chrome.onLayout(value)}
          className={cn(
            "p-1 rounded transition-colors",
            chrome.layout === value
              ? "bg-primary/15 text-primary"
              : "text-text-muted hover:text-text",
          )}
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      ))}
    </div>
  );

  const iconButton =
    "inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium text-text-muted hover:text-text hover:bg-bg-hover/70 disabled:opacity-50 transition-colors";

  const actions = (
    <>
      {canStart && (
        <button
          onClick={handleStart}
          disabled={busy}
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5" />
          )}
          <span className="hidden sm:inline">Start</span>
        </button>
      )}
      {canKill && (
        <button
          onClick={handleKill}
          disabled={busy}
          title="Kill the process"
          aria-label="Kill"
          className={cn(iconButton, "hover:text-error")}
        >
          <XCircle className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Kill</span>
        </button>
      )}
      {canDelete && (
        <button
          onClick={handleDelete}
          disabled={busy}
          title="Delete this terminal record"
          aria-label="Delete"
          className={cn(iconButton, "hover:text-error")}
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Delete</span>
        </button>
      )}
    </>
  );

  const bellButton = !isDead && (
    <button
      type="button"
      onClick={toggleBell}
      aria-pressed={bellArmed}
      title={
        bellArmed
          ? "Pinging you when this session needs you — click to stop"
          : "Ping me when this session needs me"
      }
      aria-label={
        bellArmed ? "Stop pinging for this session" : "Ping me when this session needs me"
      }
      className={cn(
        iconButton,
        "px-1.5",
        bellArmed && "text-warning hover:text-warning bg-warning/10 hover:bg-warning/15",
      )}
    >
      {bellArmed ? <BellRing className="w-3.5 h-3.5" /> : <Bell className="w-3.5 h-3.5" />}
    </button>
  );

  const connDot = (
    <span
      className="hidden sm:inline-flex items-center"
      title={`Stream ${CONN_LABEL[conn]}`}
      aria-label={`Stream ${CONN_LABEL[conn]}`}
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          CONN_DOT[conn],
          conn !== "connected" && conn !== "disconnected" && "animate-pulse",
        )}
      />
    </span>
  );

  // Header meta: what's worth a glance without stealing terminal rows.
  const meta = (
    <div className="hidden sm:flex items-center gap-2 min-w-0 text-[11px] text-text-muted">
      {host && hosts.length > 1 && (
        <span className="flex items-center gap-1 shrink-0">
          <Server className="w-3 h-3" />
          {host.name}
        </span>
      )}
      <span className="font-mono truncate" title={terminal.dir}>
        {dirTail(terminal.dir)}
      </span>
      {terminal.command && (
        <span
          className="font-mono truncate max-w-[16rem] hidden lg:inline text-text-muted/70"
          title={terminal.command}
        >
          {terminal.command}
        </span>
      )}
      {terminal.state === "exited" && terminal.exitCode != null && (
        <span className={cn("shrink-0", terminal.exitCode !== 0 && "text-error")}>
          exit {terminal.exitCode}
        </span>
      )}
      {isDead && terminal.errorMessage && (
        <span className={cn("truncate", terminal.state === "error" && "text-error")}>
          {terminal.errorMessage}
        </span>
      )}
    </div>
  );

  const header =
    variant === "primary" ? (
      // One slim toolbar: the terminal gets the rows, the header gets a glance.
      <div className="shrink-0 flex items-center gap-2 sm:gap-3 h-11 px-2 sm:px-3 border-b border-border bg-bg">
        {railCollapsed && (
          <button
            type="button"
            onClick={() => useRailStore.getState().setCollapsed(false)}
            title="Show sessions (⌃⇧B)"
            aria-label="Show sessions"
            className="hidden md:inline-flex p-1.5 rounded-md text-text-muted hover:text-text hover:bg-bg-hover/70 transition-colors"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        )}
        {/* The rail already has "← Local" on wide screens; the arrow only
            shows when there's no rail (phones, or collapsed). */}
        <Link
          href="/local"
          className={cn(
            "p-1.5 rounded-md text-text-muted hover:text-text hover:bg-bg-hover/70 transition-colors",
            !railCollapsed && "md:hidden",
          )}
          aria-label="Back to Local"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <Terminal className="w-4 h-4 text-text-muted shrink-0 hidden sm:block" />
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h1 className="text-sm font-semibold tracking-tight truncate max-w-[40vw] sm:max-w-[24rem]">
            {terminal.title}
          </h1>
          <LocalStateBadge terminal={terminal} />
          {terminal.attentionState === "needs_you" && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium text-warning bg-warning/10 border border-warning/20 truncate">
              <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse shrink-0" />
              <span className="truncate">{attentionLabel(terminal.attentionReason)}</span>
            </span>
          )}
          <span className="hidden sm:inline-block w-px h-4 bg-border shrink-0" aria-hidden />
          {meta}
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <span className="hidden md:inline-flex">
            <WorkLinkBadges links={links} size="xs" max={4} />
          </span>
          <span className="hidden lg:inline-flex">
            <SpawnSourceBadge spawnedBy={terminal.spawnedBy} />
          </span>
          {connDot}
          {bellButton}
          {layoutToggle}
          {actions}
        </div>
      </div>
    ) : (
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg">
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            terminal.attentionState === "needs_you"
              ? "bg-warning animate-pulse"
              : terminal.attentionState === "working"
                ? "bg-success"
                : "bg-text-muted/40",
          )}
        />
        <span className="text-sm font-medium truncate">{terminal.title}</span>
        <LocalStateBadge terminal={terminal} />
        {terminal.attentionState === "needs_you" && (
          <span className="text-[11px] text-warning truncate hidden sm:inline">
            {attentionLabel(terminal.attentionReason)}
          </span>
        )}
        <span className="hidden lg:inline-flex min-w-0">
          <WorkLinkBadges links={links} size="xs" max={2} />
        </span>
        <div
          className="ml-auto flex items-center gap-1 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {bellButton}
          {canKill && (
            <button
              onClick={handleKill}
              disabled={busy}
              title="Kill the process"
              aria-label="Kill"
              className="p-1.5 rounded-md text-text-muted hover:text-error hover:bg-bg-hover transition-colors"
            >
              <XCircle className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={chrome.onFocus}
            title="Make this the main pane"
            aria-label="Focus pane"
            className="p-1.5 rounded-md text-text-muted hover:text-text hover:bg-bg-hover transition-colors"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={chrome.onClose}
            title="Close pane"
            aria-label="Close pane"
            className="p-1.5 rounded-md text-text-muted hover:text-text hover:bg-bg-hover transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );

  return (
    <div className="h-full flex flex-col min-w-0 min-h-0">
      {header}
      {variant === "primary" && links.length > 0 && (
        <div className="md:hidden shrink-0 px-3 py-1.5 border-b border-border/60 bg-bg">
          <WorkLinkBadges links={links} size="xs" max={4} />
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Scrollback lives in the daemon and dies with the PTY, so a finished
            terminal has nothing to stream — show the persisted preview (the
            last lines of output) so "review the result" has a result. */}
        {isDead && terminal.preview && (
          <div className="shrink-0 border-b border-border/50 bg-[#09090b] px-4 py-3">
            <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1.5">
              Last output
            </div>
            <pre className="font-mono text-xs leading-5 whitespace-pre-wrap break-all text-[#d4d4d8] max-h-72 overflow-auto">
              {terminal.preview}
            </pre>
          </div>
        )}
        <div className="flex-1 min-h-0">
          <ErrorBoundary label="Local terminal">
            {/* Remount on leaving `pending` — the stream WS only attaches to a
                terminal that is already launching/running when it connects. */}
            <LocalTerminal
              key={terminal.state === "pending" ? "held" : "live"}
              terminalId={terminalId}
              onStatus={handleStatus}
              onExit={handleExit}
              onConn={setConn}
            />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
