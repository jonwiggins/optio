"use client";
import { OpenTerminalButton } from "@/components/open-terminal-button";
import { useLocalFeedStore } from "./local-feed";
import { MAX_PANES } from "./split-state";
import { SessionRecoveryStatus } from "@/components/session-recovery-status";
import { SessionShareButton } from "@/components/session-share-button";

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
  FolderOpen,
  Columns2,
  GitPullRequest,
  Laptop,
  Loader2,
  Maximize2,
  PanelLeftOpen,
  Play,
  RotateCcw,
  Rows2,
  Terminal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { SpawnSourceBadge, StatusDot, attentionLabel, statusDescriptor } from "./terminal-card";
import { ErrorBoundary } from "@/components/error-boundary";
import { collectWorkLinks, WorkLinkBadges } from "./work-links";
import type { SplitLayout } from "./split-state";
import { useRailStore } from "./rail-store";
import { useBellStore } from "./bell-store";
import { ensureNotificationPermission } from "./attention-watcher";
import { type ConnState } from "./conn-state";
import { TitleEditor } from "./title-editor";
import { LocalSessionIcon } from "./session-icon";
import { SessionLimitsPills, SessionUsageChip } from "./usage-chips";
import { useLocalTranscript } from "./use-transcript";
import { TranscriptView } from "./transcript-view";
import { SessionViewToggle } from "./session-view-toggle";
import { canShowChat, resolveSessionView, type SessionView } from "./session-view";
import { LocalChatComposer } from "./chat-composer";
import { useNarrow } from "./use-narrow";
import { Button } from "@/components/ui/button";
import { ConfirmPopover } from "@/components/ui/confirm-popover";

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
  onOpenTerminal?: (id: string) => void;
}

/**
 * One terminal with its own data, actions, and xterm stream. `variant`
 * picks the chrome: every pane keeps its identity and controls together,
 * with focus / close controls on extra panes.
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
  const [openingTerminal, setOpeningTerminal] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
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
  const narrow = useNarrow();
  const viewRef = useRef<SessionView | null>(null);
  const terminalAlive =
    terminal != null && terminal.state !== "exited" && terminal.state !== "error";
  const transcript = useLocalTranscript(terminalId, terminalAlive);
  // Watching a session end keeps the face you were watching; only a
  // session opened after it finished lands on the conversation.
  const wasAlive = useRef(false);
  useEffect(() => {
    if (terminalAlive) wasAlive.current = true;
    else if (wasAlive.current) setViewChoice((c) => c ?? viewRef.current ?? "screen");
  }, [terminalAlive]);
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

  const handleOpenTerminal = async () => {
    if (!terminal || openingTerminal || chrome.paneCount >= MAX_PANES) return;
    setOpeningTerminal(true);
    try {
      const { terminal: next } = await api.createLocalTerminal({
        hostId: terminal.hostId,
        dir: terminal.dir,
        spec: { kind: "shell" },
      });
      await useLocalFeedStore.getState().refetch();
      chrome.onOpenTerminal?.(next.id);
      if (next.pendingReason === "host_offline") {
        toast.info("The terminal will open when the machine reconnects");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open a terminal here");
    } finally {
      setOpeningTerminal(false);
    }
  };

  const handleKill = async () => {
    setConfirmKill(false);
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
    narrow,
  });
  // The face shown while it ran — what a session you watched end stays on.
  if (!isDead) viewRef.current = view;
  const parked = terminal.state === "pending" && terminal.pendingReason === "host_offline";
  // The likeliest reason a machine never comes back: it's online under a new name.
  const onlineElsewhere = hosts.find((h) => h.id !== terminal.hostId && h.state === "online");
  const compact = chrome.paneCount > 1;
  const viewToggle = canShowChat(terminal, hasTranscript) && view && (
    <SessionViewToggle view={view} onChange={setViewChoice} compact={compact} />
  );

  const layoutToggle = chrome.paneCount > 1 && (
    <div
      className="hidden md:flex items-center p-0.5 rounded-lg bg-bg border border-border/70"
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
            "p-1.5 rounded-md transition-colors",
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
    "inline-flex shrink-0 items-center justify-center gap-1.5 h-8 px-2 rounded-lg text-xs font-medium text-text-muted hover:text-text hover:bg-bg-hover/70 disabled:opacity-50 transition-colors";

  const terminalButton = chrome.onOpenTerminal && host && (
    <OpenTerminalButton
      onClick={handleOpenTerminal}
      busy={openingTerminal}
      disabled={chrome.paneCount >= MAX_PANES}
    />
  );

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
          <span className="hidden @3xl:inline">{runHref.label}</span>
        </Link>
      )}
      {canStart && (
        <Button size="sm" onClick={handleStart} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />}
          <span>Start</span>
        </Button>
      )}
      {canResume && (
        <Button
          size="sm"
          onClick={handleResume}
          disabled={busy}
          title="Open this session again as an interactive chat (claude --resume)"
          aria-label="Resume chat"
        >
          {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          <span>Resume chat</span>
        </Button>
      )}
      {canKill && (
        <ConfirmPopover
          open={confirmKill}
          onCancel={() => setConfirmKill(false)}
          onConfirm={handleKill}
          title="Kill this terminal's process?"
          confirmLabel="Kill"
          busy={busy}
        >
          <button
            onClick={() => setConfirmKill(true)}
            disabled={busy}
            title="Kill the process"
            aria-label="Kill"
            className={cn(iconButton, "hover:text-error")}
          >
            <XCircle className="w-3.5 h-3.5" />
          </button>
        </ConfirmPopover>
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

  const status = statusDescriptor(terminal, view === "screen" ? conn : undefined);
  const usage = (
    <div className="flex shrink-0 items-center gap-1.5" aria-label="Session usage">
      <SessionUsageChip usage={terminal.usage} collapsible />
      <SessionLimitsPills terminal={terminal} host={host} collapsible />
    </div>
  );

  const header = (
    <header
      className="shrink-0 border-b border-border/70 bg-bg-card/40"
      data-testid="local-session-header"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-1.5 @xl:px-4">
        <div className="col-span-2 flex min-w-0 items-center gap-1.5 @3xl:col-span-1">
          {variant === "primary" && railCollapsed && (
            <button
              type="button"
              onClick={() => useRailStore.getState().setCollapsed(false)}
              title="Show sessions (⌃⇧B)"
              aria-label="Show sessions"
              className={cn(iconButton, "hidden md:inline-flex")}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
          {variant === "primary" && (
            <Link
              href="/work"
              className={cn(iconButton, !railCollapsed && "md:hidden")}
              aria-label="Back to Work"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          )}
          <LocalSessionIcon terminal={terminal} className="h-4 w-4 text-primary" />
          <h1 className="flex min-w-0 overflow-hidden">
            <TitleEditor
              terminalId={terminalId}
              title={terminal.title}
              onSaved={(t) => {
                setTerminal(t);
                onTitle?.(t.title);
              }}
              inputClassName={cn(
                "font-semibold tracking-tight text-text-heading",
                compact ? "text-sm" : "text-base",
              )}
            />
          </h1>
          <div className="flex shrink-0 items-center gap-1 text-[11px] text-text-muted">
            <StatusDot terminal={terminal} conn={view === "screen" ? conn : undefined} />
            <span
              className={cn(
                "hidden @4xl:inline max-w-32 truncate",
                terminal.attentionState === "needs_you" && "text-warning",
              )}
            >
              {terminal.attentionState === "needs_you"
                ? attentionLabel(terminal.attentionReason)
                : status.label}
            </span>
            {terminal.state === "exited" && terminal.exitCode != null && (
              <span className={cn("hidden @md:inline", terminal.exitCode !== 0 && "text-error")}>
                · exit {terminal.exitCode}
              </span>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {variant === "primary" ? (
              <SessionShareButton kind="local" id={terminal.id} ownerId={terminal.userId} />
            ) : (
              <>
                <button
                  onClick={chrome.onFocus}
                  title="Make this the main pane"
                  aria-label="Focus pane"
                  className={iconButton}
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={chrome.onClose}
                  title="Close pane"
                  aria-label="Close pane"
                  className={iconButton}
                >
                  <X className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-3">
          <div
            className="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-text-muted"
            data-testid="local-session-location"
          >
            {host && (
              <Link
                href="/machines"
                title={host.name}
                className="inline-flex min-w-0 max-w-[40%] items-center gap-1.5 hover:text-text"
              >
                <Laptop className="h-3 w-3 shrink-0" />
                <span className="truncate">{host.name}</span>
              </Link>
            )}
            {host && (
              <span aria-hidden className="text-border">
                /
              </span>
            )}
            <span className="inline-flex min-w-0 items-center gap-1.5" title={terminal.dir}>
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">{terminal.dir}</span>
            </span>
            {terminal.command && (
              <span
                className="hidden @4xl:inline max-w-[30%] truncate font-mono text-text-muted/70"
                title={terminal.command}
              >
                {terminal.command}
              </span>
            )}
            <span className="hidden @md:inline-flex">
              <SpawnSourceBadge
                spawnedBy={terminal.spawnedBy}
                triggerType={terminal.triggerType}
                ticketSource={terminal.ticketSource}
                compact
              />
            </span>
          </div>
          {usage}
        </div>
        <div
          className="col-span-2 row-start-3 flex flex-wrap items-center gap-x-3 gap-y-1 @3xl:col-span-1 @3xl:col-start-2 @3xl:row-start-1"
          aria-label="Session controls"
        >
          {viewToggle ?? (
            <span className="inline-flex h-8 items-center gap-1.5 text-xs font-medium text-text-muted">
              <Terminal className="h-3.5 w-3.5" />
              Terminal
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {terminalButton}
            {layoutToggle}
            {bellButton}
            {actions}
          </div>
        </div>
      </div>
      {(links.length > 0 || (isDead && terminal.errorMessage)) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-3 py-1.5 @xl:px-4">
          <WorkLinkBadges links={links} size="xs" max={4} />
          {isDead && terminal.errorMessage && (
            <p className="text-xs text-error break-words">{terminal.errorMessage}</p>
          )}
        </div>
      )}
    </header>
  );

  return (
    // `@container`: header chrome hides by the PANE's width (container
    // queries), not the window's — a three-way split on a big screen is
    // three narrow panes.
    <div className="@container h-full flex flex-col min-w-0 min-h-0">
      {header}
      <SessionRecoveryStatus kind="local" id={terminal.id} />
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
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0">
              <TranscriptView entries={transcript.entries} live={!isDead} compact={compact} />
            </div>
            {terminal.state === "running" && (
              <LocalChatComposer
                terminalId={terminal.id}
                working={terminal.attentionState === "working"}
                compact={compact}
              />
            )}
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
