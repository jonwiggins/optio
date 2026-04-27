"use client";

import { use, useState, useEffect, useCallback, useRef } from "react";
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
  DollarSign,
  ChevronDown,
  Bot,
} from "lucide-react";
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
import { SessionChat } from "@/components/session-chat";
import { SplitPane } from "@/components/split-pane";
import { ErrorBoundary } from "@/components/error-boundary";

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
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
  const [agentType, setAgentType] = useState<string>("claude-code");
  const [availableModels, setAvailableModels] = useState<{ id: string; label: string }[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  // Refs for agent chat handlers
  const sendToAgentRef = useRef<((text: string) => void) | null>(null);
  const modelChangeRef = useRef<((model: string) => void) | null>(null);

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

  const handleModelUpdate = useCallback(
    (model: string, agent: string, models: { id: string; label: string }[]) => {
      setSelectedModel(model);
      setAgentType(agent);
      setAvailableModels(models);
    },
    [],
  );

  const handleModelChangeRegister = useCallback((handler: (model: string) => void) => {
    modelChangeRef.current = handler;
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
            {/* Live cost counter */}
            {displayCost > 0 && (
              <span className="flex items-center gap-1 text-xs text-text-muted px-2 py-1 bg-bg-card rounded-md border border-border">
                <DollarSign className="w-3 h-3" />
                {displayCost.toFixed(4)}
              </span>
            )}

            {/* Model selector */}
            {isActive && selectedModel && availableModels.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowModelDropdown(!showModelDropdown)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-bg-card border border-border text-text-muted hover:text-text transition-colors"
                >
                  <Bot className="w-3 h-3" />
                  {availableModels.find((m) => m.id === selectedModel)?.label || selectedModel}
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showModelDropdown && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setShowModelDropdown(false)}
                    />
                    <div className="absolute right-0 top-full mt-1 z-50 bg-bg-card border border-border rounded-lg shadow-lg py-1 min-w-[180px]">
                      {availableModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => {
                            modelChangeRef.current?.(m.id);
                            setShowModelDropdown(false);
                          }}
                          className={cn(
                            "w-full text-left px-3 py-1.5 text-xs hover:bg-bg transition-colors",
                            m.id === selectedModel && "text-primary font-medium",
                          )}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* PR indicator in header */}
            {prs.length > 0 && (
              <span className="flex items-center gap-1 text-xs text-text-muted px-2 py-1 bg-bg-card rounded-md border border-border">
                <GitPullRequest className="w-3 h-3" />
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

      {/* Main content — split pane for active sessions */}
      <div className="flex-1 min-h-0">
        {isActive ? (
          <SplitPane
            leftLabel="Agent Chat"
            rightLabel="Terminal"
            left={
              <ErrorBoundary label="Session chat">
                <SessionChat
                  sessionId={id}
                  onCostUpdate={handleCostUpdate}
                  onSendToAgent={handleSendToAgentRegister}
                  onModelUpdate={handleModelUpdate}
                  onModelChange={handleModelChangeRegister}
                />
              </ErrorBoundary>
            }
            right={
              <div className="h-full flex flex-col">
                <ErrorBoundary label="Terminal">
                  <SessionTerminal sessionId={id} />
                </ErrorBoundary>
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
      <GitPullRequest className="w-3 h-3 text-text-muted" />
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
