"use client";

import { use, useState, useEffect, useRef } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import Link from "next/link";
import { cn, formatRelativeTime, formatDuration } from "@/lib/utils";
import {
  ArrowLeft,
  Terminal,
  Loader2,
  FolderGit2,
  StopCircle,
  GitPullRequest,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
} from "lucide-react";
import { SessionTerminal } from "@/components/session-terminal";

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [session, setSession] = useState<any>(null);
  const [prs, setPrs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [showEndWarning, setShowEndWarning] = useState(false);

  const fetchSession = async () => {
    try {
      const [sessionRes, prsRes] = await Promise.all([api.getSession(id), api.getSessionPrs(id)]);
      setSession(sessionRes.session);
      setPrs(prsRes.prs);
    } catch {
      toast.error("Failed to load session");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSession();
  }, [id]);

  // Poll for PR updates while session is active
  useEffect(() => {
    if (!session || session.state !== "active") return;
    const interval = setInterval(() => {
      api
        .getSessionPrs(id)
        .then((res) => setPrs(res.prs))
        .catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
  }, [session?.state, id]);

  const handleEnd = async () => {
    setEnding(true);
    try {
      const res = await api.endSession(id);
      setSession(res.session);
      setShowEndWarning(false);
      toast.success("Session ended");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to end session");
    }
    setEnding(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading session...
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        Session not found
      </div>
    );
  }

  const isActive = session.state === "active";
  const repoName = session.repoUrl?.replace("https://github.com/", "") ?? "Unknown";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 px-6 py-4 border-b border-border bg-bg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/sessions" className="text-text-muted hover:text-text transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className="flex items-center gap-2">
              <Terminal className="w-5 h-5 text-primary" />
              <div>
                <h1 className="text-lg font-semibold tracking-tight">
                  {session.branch ?? `Session ${session.id.slice(0, 8)}`}
                </h1>
                <div className="flex items-center gap-3 text-xs text-text-muted">
                  <span className="flex items-center gap-1">
                    <FolderGit2 className="w-3 h-3" />
                    {repoName}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1",
                      isActive ? "text-primary" : "text-text-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        isActive ? "bg-primary animate-pulse" : "bg-text-muted",
                      )}
                    />
                    {session.state}
                  </span>
                  <span>Started {formatRelativeTime(session.createdAt)}</span>
                  {isActive && (
                    <span className="text-primary">{formatDuration(session.createdAt)}</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {session.costUsd && (
              <span className="text-xs text-text-muted px-2 py-1 bg-bg-card rounded-md border border-border">
                ${parseFloat(session.costUsd).toFixed(2)}
              </span>
            )}
            {isActive && (
              <button
                onClick={() => setShowEndWarning(true)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-bg-card border border-border text-text-muted hover:text-error hover:border-error/30 transition-colors"
              >
                <StopCircle className="w-3.5 h-3.5" />
                End Session
              </button>
            )}
          </div>
        </div>
      </div>

      {/* End session warning dialog */}
      {showEndWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-bg-card border border-border rounded-xl p-6 max-w-md mx-4 shadow-xl">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-sm">End this session?</h3>
                <p className="text-xs text-text-muted mt-2">
                  The worktree will be cleaned up. Any un-pushed commits or changes will be lost.
                  Make sure you have pushed all work before ending.
                </p>
                <div className="flex items-center gap-2 mt-4">
                  <button
                    onClick={handleEnd}
                    disabled={ending}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-error text-white text-xs font-medium hover:bg-error/90 disabled:opacity-50"
                  >
                    {ending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    End Session
                  </button>
                  <button
                    onClick={() => setShowEndWarning(false)}
                    className="px-4 py-2 rounded-lg text-xs font-medium bg-bg border border-border text-text-muted hover:text-text transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex min-h-0">
        {/* Terminal area */}
        <div className="flex-1 min-w-0">
          {isActive ? (
            <SessionTerminal sessionId={id} />
          ) : (
            <div className="h-full flex items-center justify-center text-text-muted bg-[#09090b]">
              <div className="text-center">
                <Terminal className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Session ended</p>
                {session.endedAt && (
                  <p className="text-xs mt-1">
                    Duration: {formatDuration(session.createdAt, session.endedAt)}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* PR sidebar */}
        {prs.length > 0 && (
          <div className="w-80 shrink-0 border-l border-border bg-bg overflow-y-auto">
            <div className="px-4 py-3 border-b border-border">
              <h3 className="text-xs font-medium text-text-muted uppercase tracking-wide flex items-center gap-1.5">
                <GitPullRequest className="w-3.5 h-3.5" />
                Pull Requests ({prs.length})
              </h3>
            </div>
            <div className="p-3 space-y-2">
              {prs.map((pr: any) => (
                <PrCard key={pr.id} pr={pr} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PrCard({ pr }: { pr: any }) {
  const checksIcon =
    {
      passing: <CheckCircle2 className="w-3.5 h-3.5 text-success" />,
      failing: <XCircle className="w-3.5 h-3.5 text-error" />,
      pending: <Clock className="w-3.5 h-3.5 text-warning" />,
    }[pr.prChecksStatus as string] ?? null;

  const reviewIcon =
    {
      approved: <CheckCircle2 className="w-3.5 h-3.5 text-success" />,
      changes_requested: <AlertTriangle className="w-3.5 h-3.5 text-warning" />,
      pending: <Clock className="w-3.5 h-3.5 text-text-muted" />,
    }[pr.prReviewStatus as string] ?? null;

  return (
    <div className="p-3 rounded-lg border border-border bg-bg-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <a
            href={pr.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium hover:text-primary transition-colors flex items-center gap-1"
          >
            #{pr.prNumber}
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <span
          className={cn(
            "text-[10px] font-medium uppercase px-1.5 py-0.5 rounded",
            pr.prState === "merged"
              ? "bg-purple-500/10 text-purple-400"
              : pr.prState === "closed"
                ? "bg-error/10 text-error"
                : "bg-success/10 text-success",
          )}
        >
          {pr.prState ?? "open"}
        </span>
      </div>
      <div className="flex items-center gap-3 mt-2">
        {checksIcon && (
          <span className="flex items-center gap-1 text-[11px] text-text-muted">
            {checksIcon}
            CI
          </span>
        )}
        {reviewIcon && (
          <span className="flex items-center gap-1 text-[11px] text-text-muted">
            {reviewIcon}
            Review
          </span>
        )}
      </div>
    </div>
  );
}
