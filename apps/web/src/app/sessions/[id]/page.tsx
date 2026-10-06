"use client";

import { Suspense, use, useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { OpenTerminalButton } from "@/components/open-terminal-button";
import {
  parsePodTerminals,
  podTerminalsHref,
  type PodTerminalPane,
} from "@/components/pod-terminal-panes";
import { useRailStore } from "@/components/local/rail-store";
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
  ExternalLink,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  DollarSign,
  X,
  PanelLeftOpen,
} from "lucide-react";
import { PrIcon } from "@/components/brand-icon";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { DetailHeader } from "@/components/detail-header";
import dynamic from "next/dynamic";

const SessionTerminal = dynamic(
  () => import("@/components/session-terminal").then((m) => m.SessionTerminal),
  {
    ssr: false,
    loading: () => (
      <div className="h-full bg-[#09090b] flex items-center justify-center text-text-muted text-sm">
        Loading terminal...
      </div>
    ),
  },
);
import { SessionRecoveryStatus } from "@/components/session-recovery-status";
import { SessionShareButton } from "@/components/session-share-button";
import { SessionChat } from "@/components/session-chat";
import { SplitPane } from "@/components/split-pane";
import { ErrorBoundary } from "@/components/error-boundary";

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense fallback={<div className="p-4 text-sm text-text-muted">Loading session…</div>}>
      <SessionDetail id={id} />
    </Suspense>
  );
}

function SessionDetail({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const terminalPanes = parsePodTerminals(searchParams);
  const railCollapsed = useRailStore((s) => s.collapsed);
  const [session, setSession] = useState<any>(null);
  const [modelConfig, setModelConfig] = useState<{
    claudeModel: string;
    availableModels: string[];
  } | null>(null);
  const [prs, setPrs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [ending, setEnding] = useState(false);
  const [showEndWarning, setShowEndWarning] = useState(false);
  const [liveCost, setLiveCost] = useState<number>(0);
  const [selectedModel, setSelectedModel] = useState<string>("");

  // Ref for "send to agent" handler
  const sendToAgentRef = useRef<((text: string) => void) | null>(null);

  const fetchSession = async () => {
    try {
      const [sessionRes, prsRes] = await Promise.all([api.getSession(id), api.getSessionPrs(id)]);
      setSession(sessionRes.session);
      if ((sessionRes as any).modelConfig) {
        setModelConfig((sessionRes as any).modelConfig);
        if (!selectedModel) {
          setSelectedModel((sessionRes as any).modelConfig.claudeModel ?? "sonnet");
        }
      }
      setPrs(prsRes.prs);
      // Initialize live cost from session record
      if (sessionRes.session.costUsd) {
        setLiveCost(parseFloat(sessionRes.session.costUsd));
      }
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

  const handleCostUpdate = useCallback((cost: number) => {
    setLiveCost(cost);
  }, []);

  const handleSendToAgentRegister = useCallback((handler: (text: string) => void) => {
    sendToAgentRef.current = handler;
  }, []);

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
  const displayCost = liveCost > 0 ? liveCost : session.costUsd ? parseFloat(session.costUsd) : 0;

  return (
    <div className="@container h-full flex flex-col">
      <DetailHeader
        compact
        title={session.title || session.branch || `Session ${session.id.slice(0, 8)}`}
        subtitle={
          <Link href="/work" className="inline-flex items-center gap-1 hover:text-primary">
            <ArrowLeft className="w-3 h-3" />
            Work
          </Link>
        }
        state={session.state}
        metaItems={[
          <>
            <Terminal className="w-3 h-3" />
            Pod session
          </>,
          <span key="repo" className="inline-flex items-center gap-1 font-mono">
            <FolderGit2 className="w-3 h-3" />
            {repoName}
          </span>,
          <>
            <Clock className="w-3 h-3" />
            Started {formatRelativeTime(session.createdAt)}
            {isActive && (
              <span className="text-primary"> · {formatDuration(session.createdAt)}</span>
            )}
          </>,
        ]}
        rightSlot={
          <>
            {railCollapsed && (
              <button
                type="button"
                aria-label="Show sessions"
                title="Show sessions"
                onClick={() => useRailStore.getState().setCollapsed(false)}
                className="hidden md:inline-flex rounded-md p-1.5 text-text-muted hover:text-text"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
            )}
            {isActive && (
              <OpenTerminalButton
                disabled={terminalPanes.length >= 2}
                onClick={() => {
                  const next = (["1", "2"] as PodTerminalPane[]).find(
                    (p) => !terminalPanes.includes(p),
                  );
                  if (next) router.replace(podTerminalsHref(id, [...terminalPanes, next]));
                }}
              />
            )}
            <SessionShareButton kind="pod" id={id} ownerId={session.userId} />
            {/* Live cost counter */}
            {displayCost > 0 && (
              <span className="flex items-center gap-1 text-xs text-text-muted px-2 py-1 bg-bg-card rounded-md border border-border">
                <DollarSign className="w-3 h-3" />
                {displayCost.toFixed(4)}
              </span>
            )}

            {/* Model selector */}
            {isActive && modelConfig && (
              <select
                aria-label="Chat model"
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
                className={inputClass({ size: "sm", className: "w-auto max-w-40" })}
              >
                {modelConfig.availableModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            )}

            {/* PR indicator in header */}
            {prs.length > 0 && (
              <span className="flex items-center gap-1 text-xs text-text-muted px-2 py-1 bg-bg-card rounded-md border border-border">
                <PrIcon colored={false} className="w-3 h-3" />
                {prs.length} PR{prs.length > 1 ? "s" : ""}
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
          </>
        }
      />

      <SessionRecoveryStatus kind="pod" id={id} />
      {/* End session warning dialog */}
      {showEndWarning && (
        <Dialog
          title="End this session?"
          onClose={() => setShowEndWarning(false)}
          busy={ending}
          footer={
            <>
              <Button
                variant="secondary"
                onClick={() => setShowEndWarning(false)}
                disabled={ending}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={handleEnd} disabled={ending}>
                {ending ? <Loader2 className="animate-spin" /> : <StopCircle />}End Session
              </Button>
            </>
          }
        >
          <div className="flex items-start gap-3 text-sm leading-relaxed text-text-muted">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <p>
              This ends the chat and every terminal in this session. Push or save your work before
              ending; retained workspace files are not a backup.
            </p>
          </div>
        </Dialog>
      )}

      {/* Main content — split pane for active sessions */}
      <div className="flex-1 min-h-0">
        {isActive ? (
          <SplitPane
            leftLabel="Agent Chat"
            rightLabel="Terminal"
            revealRightKey={terminalPanes.join(",")}
            left={
              <ErrorBoundary label="Session chat">
                <SessionChat
                  sessionId={id}
                  selectedModel={selectedModel}
                  onCostUpdate={handleCostUpdate}
                  onSendToAgent={handleSendToAgentRegister}
                />
              </ErrorBoundary>
            }
            right={
              <div className="h-full flex flex-col">
                <div className="flex-1 min-h-0 flex flex-col">
                  <div className="flex-1 min-h-0 basis-0" data-session-pane="pod-main">
                    <ErrorBoundary label="Terminal">
                      <SessionTerminal sessionId={id} />
                    </ErrorBoundary>
                  </div>
                  {terminalPanes.map((pane) => (
                    <section
                      key={pane}
                      data-session-pane={`pod-${pane}`}
                      aria-label={`Terminal ${Number(pane) + 1}`}
                      className="flex flex-1 min-h-0 basis-0 flex-col border-t border-border"
                    >
                      <div className="flex shrink-0 items-center gap-2 bg-bg px-3 py-1.5 text-xs text-text-muted">
                        <Terminal className="h-3.5 w-3.5 text-primary" />
                        <span>Terminal {Number(pane) + 1}</span>
                        <button
                          type="button"
                          aria-label={`Close terminal ${Number(pane) + 1} pane`}
                          title="Close pane; keep the shell running"
                          onClick={() =>
                            router.replace(
                              podTerminalsHref(
                                id,
                                terminalPanes.filter((p) => p !== pane),
                              ),
                            )
                          }
                          className="ml-auto rounded p-1 hover:bg-bg-hover hover:text-text"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="flex-1 min-h-0">
                        <ErrorBoundary label="Terminal">
                          <SessionTerminal sessionId={id} terminal={pane} />
                        </ErrorBoundary>
                      </div>
                    </section>
                  ))}
                </div>
                {/* PR cards inline below terminal when present */}
                {prs.length > 0 && (
                  <div className="shrink-0 border-t border-border bg-bg px-3 py-2">
                    <div className="flex items-center gap-2 overflow-x-auto">
                      {prs.map((pr: any) => (
                        <PrBadge key={pr.id} pr={pr} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            }
          />
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
              {displayCost > 0 && <p className="text-xs mt-1">Cost: ${displayCost.toFixed(4)}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Compact inline PR badge for the terminal footer */
function PrBadge({ pr }: { pr: any }) {
  const checksIcon =
    {
      passing: <CheckCircle2 className="w-3 h-3 text-success" />,
      failing: <XCircle className="w-3 h-3 text-error" />,
      pending: <Clock className="w-3 h-3 text-warning" />,
    }[pr.prChecksStatus as string] ?? null;

  const reviewIcon =
    {
      approved: <CheckCircle2 className="w-3 h-3 text-success" />,
      changes_requested: <AlertTriangle className="w-3 h-3 text-warning" />,
      pending: <Clock className="w-3 h-3 text-text-muted" />,
    }[pr.prReviewStatus as string] ?? null;

  return (
    <a
      href={pr.prUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-bg-card text-xs hover:border-primary/30 transition-colors"
    >
      <PrIcon state={pr.prState} className="w-3 h-3" />
      <span className="font-medium">#{pr.prNumber}</span>
      <span
        className={cn(
          "text-[10px] font-medium uppercase px-1 py-0.5 rounded",
          pr.prState === "merged"
            ? "bg-purple-500/10 text-purple-400"
            : pr.prState === "closed"
              ? "bg-error/10 text-error"
              : "bg-success/10 text-success",
        )}
      >
        {pr.prState ?? "open"}
      </span>
      {checksIcon}
      {reviewIcon}
      <ExternalLink className="w-3 h-3 text-text-muted" />
    </a>
  );
}
