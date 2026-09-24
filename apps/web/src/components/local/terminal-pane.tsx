"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Bell,
  BellRing,
  Briefcase,
  Columns2,
  GitPullRequest,
  Laptop,
  Loader2,
  Maximize2,
  PanelLeftOpen,
  Play,
  RotateCcw,
  Rows2,
  Server,
  Terminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { SpawnSourceBadge, StatusDot, attentionLabel, dirTail } from "./terminal-card";
import { ErrorBoundary } from "@/components/error-boundary";
import { collectWorkLinks, WorkLinkBadges } from "./work-links";
import type { SplitLayout } from "./split-state";
import { useRailStore } from "./rail-store";
import { useBellStore } from "./bell-store";
import { ensureNotificationPermission } from "./attention-watcher";
import { type ConnState } from "./conn-state";
import { TitleEditor } from "./title-editor";
import { SessionLimitsPills, SessionUsageChip } from "./usage-chips";
import { useTitleFit } from "./use-title-fit";
import { useLocalTranscript } from "./use-transcript";
import { TranscriptView } from "./transcript-view";
import { SessionViewToggle } from "./session-view-toggle";
import { resolveSessionView, type SessionView } from "./session-view";

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
  const router = useRouter();
  const [terminal, setTerminal] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  // True once the stream has painted real bytes into the xterm: live output,
  // or the final screen the daemon recorded at exit. `streamSettled` marks
  // the stream's end (exit frame, or a stop with nothing more to come) — only
  // then do we know a dead terminal has no screen to show. See the render.
  const [streamedOutput, setStreamedOutput] = useState(false);
  const [streamSettled, setStreamSettled] = useState(false);
  const handleOutput = useCallback(() => setStreamedOutput(true), []);
  const handleConn = useCallback((next: ConnState) => {
    setConn(next);
    if (next === "disconnected") setStreamSettled(true);
  }, []);
  // Resume/restart parks the terminal in `pending` and remounts the xterm
  // fresh — forget the old screen so a second exit falls back to the preview.
  useEffect(() => {
    if (terminal?.state === "pending") {
      setStreamedOutput(false);
      setStreamSettled(false);
    }
  }, [terminal?.state]);
  // The conversation behind an agent session (empty for shells and rows
  // from before transcripts were recorded). A finished session opens on it;
  // the toggle switches to the recorded screen and back.
  const [viewChoice, setViewChoice] = useState<SessionView | null>(null);
  const terminalAlive =
    terminal != null && terminal.state !== "exited" && terminal.state !== "error";
  const transcript = useLocalTranscript(terminalId, terminalAlive);
  // Watching a session end keeps the screen you were watching; only a
  // session opened after it finished lands on the conversation.
  const wasAlive = useRef(false);
  useEffect(() => {
    if (terminalAlive) wasAlive.current = true;
    else if (wasAlive.current) setViewChoice((c) => c ?? "screen");
  }, [terminalAlive]);
  const fit = useTitleFit(!loading && terminal != null);
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

  // A terminal that executes a Job run / Repo Task links back to that run's
  // page. Job runs live under their job, so resolve the workflow id once.
  const [runHref, setRunHref] = useState<{ href: string; label: string } | null>(null);
  useEffect(() => {
    if (!terminal) return;
    if (terminal.taskId) {
      setRunHref({ href: `/tasks/${terminal.taskId}`, label: "Open task" });
      return;
    }
    if (terminal.workflowRunId) {
      let cancelled = false;
      api
        .getWorkflowRun(terminal.workflowRunId)
        .then((res) => {
          if (!cancelled) {
            setRunHref({
              href: `/jobs/${res.run.workflowId}/runs/${res.run.id}`,
              label: "Open run",
            });
          }
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    setRunHref(null);
  }, [terminal?.taskId, terminal?.workflowRunId]);

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

  const handleResume = async () => {
    setBusy(true);
    try {
      const res = await api.resumeLocalTerminal(terminalId);
      const next = res.terminal;
      if (next.state === "pending" && next.pendingReason === "host_offline") {
        toast.info(
          `${host?.name ?? "The machine"} is offline — the chat starts when it reconnects`,
        );
      } else {
        toast.success(
          res.reused ? "Opening the chat already resumed" : "Resuming session in a new terminal",
        );
      }
      router.push(`/local/${next.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resume");
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
      // The exit frame is the last thing the stream sends (after any
      // recorded screen), so from here `streamedOutput` is final.
      setStreamSettled(true);
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
          <Link href="/work" className="text-xs text-primary hover:underline">
            Back to Work
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
  // A run whose agent reported its own session id can be picked up as a chat.
  const canResume =
    terminal.state === "exited" &&
    terminal.spec?.kind === "agent" &&
    (terminal.spec.agent === "claude-code" || terminal.spec.agent === "codex") &&
    !!terminal.agentSessionId;
  const links = collectWorkLinks(terminal);
  const hasTranscript = transcript.entries.length > 0;
  // A finished session's machine may still be reading its conversation off
  // disk: hold the default view until the first entries land (or it gives up).
  const readingTranscript = transcript.backfilling && !hasTranscript;
  const view = resolveSessionView(viewChoice, {
    isDead,
    hasTranscript,
    loaded: transcript.loaded && !readingTranscript,
  });
  const parked = terminal.state === "pending" && terminal.pendingReason === "host_offline";
  // The likeliest reason a machine never comes back: it's online under a new name.
  const onlineElsewhere = hosts.find((h) => h.id !== terminal.hostId && h.state === "online");
  const viewToggle = hasTranscript && view && (
    <SessionViewToggle view={view} onChange={setViewChoice} />
  );

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
      {runHref && (
        <Link
          href={runHref.href}
          className={iconButton}
          title={runHref.label}
          aria-label={runHref.label}
        >
          {terminal.taskId ? (
            <GitPullRequest className="w-3.5 h-3.5" />
          ) : (
            <Briefcase className="w-3.5 h-3.5" />
          )}
          <span className="hidden sm:inline">{runHref.label}</span>
        </Link>
      )}
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
      {canResume && (
        <button
          onClick={handleResume}
          disabled={busy}
          title="Open this session again as an interactive chat (claude --resume)"
          aria-label="Resume chat"
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RotateCcw className="w-3.5 h-3.5" />
          )}
          <span className="hidden sm:inline">Resume chat</span>
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

  // Hidden full-dress copy of the title row; useTitleFit compares its width
  // to the row's to decide when the badges must drop to dots. Keep in sync
  // with what the row renders at full width.
  const titleGhost = (
    <div
      ref={fit.ghostRef}
      aria-hidden
      className="absolute left-0 top-0 invisible pointer-events-none flex items-center gap-2 whitespace-nowrap"
    >
      <span
        className={
          variant === "primary" ? "text-sm font-semibold px-1.5" : "text-sm font-medium px-1.5"
        }
      >
        {terminal.title}
      </span>
      {terminal.attentionState === "needs_you" && (
        <span className="text-[11px]">{attentionLabel(terminal.attentionReason)}</span>
      )}
    </div>
  );

  // The attention reason as plain text beside the title — only while the
  // title has room to spare (the dot alone carries it otherwise).
  const attentionText = terminal.attentionState === "needs_you" && !fit.compact && (
    <span className="text-[11px] text-warning truncate shrink-[4] min-w-0">
      {attentionLabel(terminal.attentionReason)}
    </span>
  );

  // Header meta: what's worth a glance without stealing terminal rows.
  const meta = (
    // shrink-[8]: the dir / command give way well before the title does.
    <div className="hidden @lg:flex items-center gap-2 min-w-0 shrink-[8] text-[11px] text-text-muted">
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
          className="font-mono truncate max-w-[16rem] hidden @4xl:inline text-text-muted/70"
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
        {/* The rail already has "← Sessions" on wide screens; the arrow only
            shows when there's no rail (phones, or collapsed). */}
        <Link
          href="/work"
          className={cn(
            "p-1.5 rounded-md text-text-muted hover:text-text hover:bg-bg-hover/70 transition-colors",
            !railCollapsed && "md:hidden",
          )}
          aria-label="Back to Work"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <StatusDot terminal={terminal} conn={view === "screen" ? conn : undefined} />
        <div
          ref={fit.rowRef}
          className="relative flex items-center gap-2 min-w-0 flex-1 overflow-hidden"
        >
          {titleGhost}
          <h1 className="min-w-0 shrink max-w-[28rem] flex">
            <TitleEditor
              terminalId={terminalId}
              title={terminal.title}
              onSaved={(t) => {
                setTerminal(t);
                onTitle?.(t.title);
              }}
              inputClassName="text-sm font-semibold tracking-tight"
            />
          </h1>
          {attentionText}
          {!fit.compact && (
            <>
              <span className="hidden @lg:inline-block w-px h-4 bg-border shrink-0" aria-hidden />
              {meta}
            </>
          )}
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <span className="hidden @2xl:inline-flex">
            <WorkLinkBadges links={links} size="xs" max={4} />
          </span>
          <SessionUsageChip usage={terminal.usage} collapsible className="hidden @md:inline-flex" />
          <SessionLimitsPills
            terminal={terminal}
            host={host}
            collapsible
            className="hidden @lg:inline-flex"
          />
          <span className="hidden @4xl:inline-flex">
            <SpawnSourceBadge spawnedBy={terminal.spawnedBy} triggerType={terminal.triggerType} />
          </span>
          {viewToggle}
          {bellButton}
          {layoutToggle}
          {actions}
        </div>
      </div>
    ) : (
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-border bg-bg">
        <StatusDot terminal={terminal} conn={view === "screen" ? conn : undefined} />
        <div
          ref={fit.rowRef}
          className="relative flex items-center gap-2 min-w-0 flex-1 overflow-hidden"
        >
          {titleGhost}
          <TitleEditor
            terminalId={terminalId}
            title={terminal.title}
            onSaved={setTerminal}
            className="shrink max-w-[28rem]"
            inputClassName="text-sm font-medium"
          />
          {attentionText}
          {!fit.compact && (
            <span className="hidden @3xl:inline-flex min-w-0">
              <WorkLinkBadges links={links} size="xs" max={2} />
            </span>
          )}
        </div>
        <SessionUsageChip usage={terminal.usage} collapsible className="hidden @sm:inline-flex" />
        <SessionLimitsPills
          terminal={terminal}
          host={host}
          collapsible
          className="hidden @md:inline-flex"
        />
        <div
          className="ml-auto flex items-center gap-1 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {viewToggle}
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
    // `@container`: header chrome hides by the PANE's width (container
    // queries), not the window's — a three-way split on a big screen is
    // three narrow panes.
    <div className="@container h-full flex flex-col min-w-0 min-h-0">
      {header}
      {variant === "primary" && links.length > 0 && (
        <div className="md:hidden shrink-0 px-3 py-1.5 border-b border-border/60 bg-bg">
          <WorkLinkBadges links={links} size="xs" max={4} />
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* A finished agent session opens on its conversation (see
            resolveSessionView); the branches below are the screen view.
            A finished terminal replays the screen the daemon recorded at exit
            into the xterm, at the grid it ran at, so it reads the way it did
            live. Only when the stream has ended without a byte — a row from
            before screens were recorded — does the persisted text preview
            (the last lines of output) take the terminal's place, full height,
            so "review the result" still has a result. Never stack the two:
            that squeezes the xterm into a few unreadable rows. */}
        {view === null ? (
          <div className="flex-1 min-h-0 bg-[#09090b] flex items-center justify-center text-text-muted text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            {readingTranscript
              ? `Reading the conversation from ${host?.name ?? "its machine"}…`
              : "Loading session…"}
          </div>
        ) : view === "transcript" ? (
          <div className="flex-1 min-h-0">
            <TranscriptView entries={transcript.entries} live={!isDead} />
          </div>
        ) : parked ? (
          <div className="flex-1 min-h-0 bg-[#09090b] flex flex-col items-center justify-center gap-2 px-6 text-center">
            <Laptop className="w-6 h-6 text-text-muted/60" />
            <p className="text-sm text-text">Waiting for {host?.name ?? "its machine"}</p>
            <p className="text-xs text-text-muted max-w-sm">
              This session starts on its own when that machine&apos;s daemon reconnects (
              <code className="font-mono">optio local up</code>).
            </p>
            {onlineElsewhere && (
              <p className="text-xs text-text-muted max-w-sm">
                Is {onlineElsewhere.name} the same computer under a new name?{" "}
                <Link href="/machines" className="text-primary hover:underline">
                  Merge them on Machines
                </Link>
              </p>
            )}
          </div>
        ) : isDead && streamSettled && !streamedOutput && terminal.preview ? (
          <div className="flex-1 min-h-0 flex flex-col bg-[#09090b] px-4 py-3">
            <div className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted mb-1.5">
              Last output
            </div>
            <pre className="flex-1 min-h-0 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-[#d4d4d8] overflow-auto">
              {terminal.preview}
            </pre>
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <ErrorBoundary label="Local terminal">
              {/* Remount on leaving `pending` — the stream WS only attaches to a
                  terminal that is already launching/running when it connects. */}
              <LocalTerminal
                key={terminal.state === "pending" ? "held" : "live"}
                terminalId={terminalId}
                onStatus={handleStatus}
                onExit={handleExit}
                onConn={handleConn}
                onOutput={handleOutput}
              />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
}
