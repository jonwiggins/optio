"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ExternalLink, Laptop, Loader2, RotateCcw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "@/components/error-boundary";
import { useLocalHosts } from "@/hooks/use-local-hosts";
import { StatusDot, attentionLabel, dirTail, localStateLabel } from "./terminal-card";
import { collectWorkLinks, WorkLinkBadges } from "./work-links";
import { SessionUsageChip } from "./usage-chips";
import type { ConnState } from "./conn-state";
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

/**
 * The local terminal behind a Job run or Repo Task, embedded in that run's
 * own page (it replaces the pod log viewer for local runs). A slim status
 * strip — state, attention, machine + directory, usage, PR links, kill /
 * resume, "open in Local" — over the same xterm stream the Local cockpit
 * uses. The page around it keeps its own header and pipeline sidebar.
 */
export function EmbeddedLocalSession({
  terminalId,
  className,
  onTerminal,
}: {
  terminalId: string;
  className?: string;
  /** Fires on every refresh so the page can mirror state (e.g. refetch the run on exit). */
  onTerminal?: (terminal: any) => void;
}) {
  const { hosts } = useLocalHosts({ pollMs: 30_000 });
  const [terminal, setTerminal] = useState<any>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [streamedOutput, setStreamedOutput] = useState(false);
  const handleOutput = useCallback(() => setStreamedOutput(true), []);
  const onTerminalRef = useRefLatest(onTerminal);
  // Same rule as the Local pane: a finished run opens on its conversation,
  // a live one on its screen, and a run you watched end stays on the screen.
  const [viewChoice, setViewChoice] = useState<SessionView | null>(null);
  const terminalAlive =
    terminal != null && terminal.state !== "exited" && terminal.state !== "error";
  const transcript = useLocalTranscript(terminalId, terminalAlive);
  const wasAlive = useRef(false);
  useEffect(() => {
    if (terminalAlive) wasAlive.current = true;
    else if (wasAlive.current) setViewChoice((c) => c ?? "screen");
  }, [terminalAlive]);

  const fetchTerminal = useCallback(async () => {
    try {
      const res = await api.getLocalTerminal(terminalId);
      setTerminal(res.terminal);
      setMissing(false);
      onTerminalRef.current?.(res.terminal);
      return res.terminal;
    } catch {
      setMissing(true);
      return null;
    }
  }, [terminalId, onTerminalRef]);

  useEffect(() => {
    fetchTerminal();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchTerminal();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchTerminal]);

  useEffect(() => {
    if (terminal?.state === "pending") setStreamedOutput(false);
  }, [terminal?.state]);

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

  const handleKill = async () => {
    if (!confirm("Kill the agent process on your machine?")) return;
    setBusy(true);
    try {
      await api.killLocalTerminal(terminalId);
      toast.success("Kill signal sent");
      fetchTerminal();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to kill the session");
    }
    setBusy(false);
  };

  const handleResume = async () => {
    setBusy(true);
    try {
      const res = await api.resumeLocalTerminal(terminalId);
      const next = res.terminal;
      if (next.state === "pending" && next.pendingReason === "host_offline") {
        const name = hosts.find((h) => h.id === next.hostId)?.name ?? "The machine";
        toast.info(`${name} is offline — the chat starts when it reconnects`);
      } else {
        toast.success(
          res.reused
            ? "Opening the chat already resumed"
            : "Resuming the session in a new terminal",
        );
      }
      window.open(`/local/${next.id}`, "_self");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resume");
    }
    setBusy(false);
  };

  if (missing) {
    return (
      <div
        className={cn("h-full flex items-center justify-center text-sm text-text-muted", className)}
      >
        The local session behind this run is gone (its terminal record was deleted).
      </div>
    );
  }
  if (!terminal) {
    return (
      <div className={cn("h-full flex items-center justify-center text-text-muted", className)}>
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading session…
      </div>
    );
  }

  const host = hosts.find((h) => h.id === terminal.hostId);
  const isDead = terminal.state === "exited" || terminal.state === "error";
  const canKill = terminal.state === "running" || terminal.state === "launching";
  const canResume =
    terminal.state === "exited" &&
    terminal.spec?.kind === "agent" &&
    (terminal.spec.agent === "claude-code" || terminal.spec.agent === "codex") &&
    !!terminal.agentSessionId;
  const links = collectWorkLinks(terminal);
  const hasTranscript = transcript.entries.length > 0;
  // The machine may still be reading a finished session's conversation off disk.
  const readingTranscript = transcript.backfilling && !hasTranscript;
  const view = resolveSessionView(viewChoice, {
    isDead,
    hasTranscript,
    loaded: transcript.loaded && !readingTranscript,
  });
  const button =
    "inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium text-text-muted hover:text-text hover:bg-bg-hover/70 disabled:opacity-50 transition-colors";

  return (
    <div className={cn("h-full flex flex-col min-h-0", className)}>
      <div className="shrink-0 flex items-center gap-2 px-3 h-10 border-b border-border bg-bg text-xs">
        <StatusDot terminal={terminal} conn={view === "screen" ? conn : undefined} />
        <span className="font-medium">{localStateLabel(terminal)}</span>
        {terminal.attentionState === "needs_you" && (
          <span className="text-warning truncate">{attentionLabel(terminal.attentionReason)}</span>
        )}
        {terminal.state === "pending" && terminal.pendingReason === "host_offline" && (
          <span className="text-text-muted truncate">
            — starts when {host?.name ?? "the machine"} reconnects
          </span>
        )}
        <span className="hidden sm:inline-flex items-center gap-1 text-text-muted min-w-0">
          <Laptop className="w-3 h-3 shrink-0" />
          <span className="truncate">{host?.name ?? "local"}</span>
          <span className="text-text-muted/50">·</span>
          <span className="font-mono truncate" title={terminal.dir}>
            {dirTail(terminal.dir)}
          </span>
        </span>
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
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <span className="hidden md:inline-flex">
            <WorkLinkBadges links={links} size="xs" max={3} />
          </span>
          <SessionUsageChip usage={terminal.usage} collapsible className="hidden sm:inline-flex" />
          {hasTranscript && view && <SessionViewToggle view={view} onChange={setViewChoice} />}
          {canResume && (
            <button
              onClick={handleResume}
              disabled={busy}
              className={button}
              title="Resume as a chat"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Resume chat</span>
            </button>
          )}
          {canKill && (
            <button
              onClick={handleKill}
              disabled={busy}
              className={cn(button, "hover:text-error")}
              title="Kill the agent process"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Kill</span>
            </button>
          )}
          <Link href={`/local/${terminal.id}`} className={button} title="Open in Local">
            <ExternalLink className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Open in Local</span>
          </Link>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {view === null ? (
          <div className="flex-1 min-h-0 bg-[#09090b] flex items-center justify-center text-text-muted text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            {readingTranscript
              ? `Reading the conversation from ${host?.name ?? "your machine"}…`
              : "Loading session…"}
          </div>
        ) : view === "transcript" ? (
          <div className="flex-1 min-h-0">
            <TranscriptView entries={transcript.entries} live={!isDead} />
          </div>
        ) : isDead && !streamedOutput && terminal.preview ? (
          <div className="flex-1 min-h-0 flex flex-col bg-[#09090b] px-4 py-3">
            <div className="shrink-0 text-[10px] uppercase tracking-wide text-text-muted mb-1.5">
              Last output
            </div>
            <pre className="flex-1 min-h-0 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-[#d4d4d8] overflow-auto">
              {terminal.preview}
            </pre>
          </div>
        ) : isDead && !streamedOutput ? (
          <div className="flex-1 min-h-0 bg-[#09090b] flex items-center justify-center text-xs text-text-muted px-4 text-center">
            The session ended before this page attached; its scrollback lived on your machine.
          </div>
        ) : (
          <div className="flex-1 min-h-0">
            <ErrorBoundary label="Local session">
              <LocalTerminal
                key={terminal.state === "pending" ? "held" : "live"}
                terminalId={terminalId}
                onStatus={handleStatus}
                onExit={handleExit}
                onConn={setConn}
                onOutput={handleOutput}
              />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
}

function useRefLatest<T>(value: T) {
  const ref = useState<{ current: T }>(() => ({ current: value }))[0];
  ref.current = value;
  return ref;
}
