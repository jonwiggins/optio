"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Play,
  Server,
  Terminal,
  Ticket,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  LocalStateBadge,
  SpawnSourceBadge,
  attentionLabel,
  dirTail,
} from "@/components/local/terminal-card";
import { ErrorBoundary } from "@/components/error-boundary";

const LocalTerminal = dynamic(
  () => import("@/components/local/local-terminal").then((m) => m.LocalTerminal),
  {
    ssr: false,
    loading: () => (
      <div className="h-full bg-[#09090b] flex items-center justify-center text-text-muted text-sm">
        Loading terminal...
      </div>
    ),
  },
);

export default function LocalTerminalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [terminal, setTerminal] = useState<any>(null);
  const [hosts, setHosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  usePageTitle(terminal?.title ?? "Local");

  const fetchTerminal = useCallback(async () => {
    try {
      const res = await api.getLocalTerminal(id);
      setTerminal(res.terminal);
      return res.terminal;
    } catch {
      return null;
    }
  }, [id]);

  useEffect(() => {
    fetchTerminal().finally(() => setLoading(false));
    api
      .listLocalHosts()
      .then((res) => setHosts(res.hosts))
      .catch(() => {});
  }, [id, fetchTerminal]);

  const host = terminal ? hosts.find((h) => h.id === terminal.hostId) : null;

  // Poll as a fallback — the stream WS pushes status while attached.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchTerminal();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchTerminal]);

  const handleStart = async () => {
    setBusy(true);
    try {
      const res = await api.startLocalTerminal(id);
      setTerminal(res.terminal);
      toast.success("Terminal started");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start terminal");
    }
    setBusy(false);
  };

  const handleKill = async () => {
    if (!confirm("Kill this terminal's process?")) return;
    setBusy(true);
    try {
      await api.killLocalTerminal(id);
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
      await api.deleteLocalTerminal(id);
      toast.success("Terminal deleted");
      router.push("/local");
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
        <Link href="/local" className="text-xs text-primary hover:underline">
          Back to Local
        </Link>
      </div>
    );
  }

  const canStart = terminal.state === "pending";
  const canKill = terminal.state === "running" || terminal.state === "launching";
  const canDelete =
    terminal.state === "exited" || terminal.state === "error" || terminal.state === "pending";

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-6 py-3.5 border-b border-border bg-bg">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/local" className="text-text-muted hover:text-text transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <Terminal className="w-5 h-5 text-primary shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-lg font-semibold tracking-tight truncate">{terminal.title}</h1>
                <LocalStateBadge terminal={terminal} />
                {terminal.attentionState === "needs_you" && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium tracking-wide uppercase text-warning bg-warning/10 border border-warning/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
                    {attentionLabel(terminal.attentionReason)}
                  </span>
                )}
                <SpawnSourceBadge spawnedBy={terminal.spawnedBy} />
              </div>
              <div className="flex items-center gap-3 mt-0.5 text-xs text-text-muted flex-wrap">
                {host && (
                  <span className="flex items-center gap-1">
                    <Server className="w-3 h-3" />
                    {host.name}
                  </span>
                )}
                <span className="font-mono" title={terminal.dir}>
                  {dirTail(terminal.dir)}
                </span>
                {terminal.command && (
                  <span className="font-mono truncate max-w-md" title={terminal.command}>
                    {terminal.command}
                  </span>
                )}
                {terminal.state === "exited" && terminal.exitCode != null && (
                  <span className={cn(terminal.exitCode !== 0 && "text-error")}>
                    exit {terminal.exitCode}
                  </span>
                )}
                {terminal.state === "error" && terminal.errorMessage && (
                  <span className="text-error">{terminal.errorMessage}</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {terminal.ticketUrl && (
              <a
                href={terminal.ticketUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border bg-bg-card text-xs text-text-muted hover:text-text hover:border-primary/30 transition-colors"
              >
                <Ticket className="w-3.5 h-3.5" />
                {terminal.ticketSource ?? "ticket"}
                {terminal.ticketExternalId ? ` #${terminal.ticketExternalId}` : ""}
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {canStart && (
              <button
                onClick={handleStart}
                disabled={busy}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                {busy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                Start
              </button>
            )}
            {canKill && (
              <button
                onClick={handleKill}
                disabled={busy}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-bg-card border border-border text-text-muted hover:text-error hover:border-error/30 disabled:opacity-50 transition-colors"
              >
                <XCircle className="w-3.5 h-3.5" />
                Kill
              </button>
            )}
            {canDelete && (
              <button
                onClick={handleDelete}
                disabled={busy}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-bg-card border border-border text-text-muted hover:text-error hover:border-error/30 disabled:opacity-50 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <ErrorBoundary label="Local terminal">
          {/* Remount on leaving `pending` — the stream WS only attaches to a
              terminal that is already launching/running when it connects. */}
          <LocalTerminal
            key={terminal.state === "pending" ? "held" : "live"}
            terminalId={id}
            onStatus={handleStatus}
            onExit={handleExit}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}
