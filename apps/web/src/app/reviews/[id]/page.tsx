"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { cn, formatRelativeTime } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import { usePrReviewLogs } from "@/hooks/use-pr-review-logs";
import { classifyError } from "@optio/shared";
import { ErrorBoundary } from "@/components/error-boundary";
import { LogViewer } from "@/components/log-viewer";
import { DetailHeader } from "@/components/detail-header";
import { StatePipelineStrip } from "@/components/state-pipeline-strip";
import { PrStatusBar } from "@/components/pr-status-bar";
import { ChatTranscript, ChatComposer, type ChatMessage } from "@/components/chat-box";
import { ReviewPipelineTimeline } from "@/components/review-pipeline-timeline";
import {
  Loader2,
  Check,
  X,
  MessageSquare,
  Send,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  GitMerge,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  ExternalLink,
  Clock,
  Zap,
  GitPullRequest,
  XCircle,
  RotateCcw,
} from "lucide-react";

interface Review {
  id: string;
  workspaceId: string | null;
  prUrl: string;
  prNumber: number;
  repoOwner: string;
  repoName: string;
  repoUrl: string;
  headSha: string;
  state: string;
  verdict: string | null;
  summary: string | null;
  fileComments: Array<{ path: string; line?: number; side?: string; body: string }> | null;
  origin: string;
  userEngaged: boolean;
  autoSubmitted: boolean;
  submittedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

const PIPELINE_STEPS = [
  { key: "queued", label: "Queued" },
  { key: "waiting_ci", label: "CI" },
  { key: "reviewing", label: "Reviewing" },
  { key: "ready", label: "Ready" },
  { key: "submitted", label: "Submitted" },
];

function pipelineCurrentIndex(state: string): number {
  if (state === "stale") return 3;
  if (state === "failed" || state === "cancelled") return -1;
  return PIPELINE_STEPS.findIndex((s) => s.key === state);
}

export default function ReviewDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const _router = useRouter();

  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<any[]>([]);
  const [prStatus, setPrStatus] = useState<any>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [showTimeline, setShowTimeline] = useState(true);
  const [verdictCollapsed, setVerdictCollapsed] = useState(false);

  // Editable fields
  const [summary, setSummary] = useState("");
  const [verdict, setVerdict] = useState<string>("");
  const [comments, setComments] = useState<
    Array<{ path: string; line?: number; side?: string; body: string }>
  >([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reReviewing, setReReviewing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<"squash" | "merge" | "rebase">("squash");
  const [mergeMenuOpen, setMergeMenuOpen] = useState(false);

  // Live log streaming via WebSocket — same hook contract as the task page's
  // useLogs, plugged into LogViewer's externalLogs prop.
  const externalLogs = usePrReviewLogs(id);

  usePageTitle(review ? `Review: PR #${review.prNumber}` : "Review");

  const fetchAll = useCallback(async () => {
    try {
      const [r, runsRes] = await Promise.all([api.getPrReview(id), api.listPrReviewRuns(id)]);
      setReview(r.review);
      setRuns(runsRes.runs);
      setSummary(r.review.summary ?? "");
      setVerdict(r.review.verdict ?? "");
      setComments(r.review.fileComments ?? []);
      setDirty(false);

      if (r.review.prUrl) {
        api
          .getPrStatus(r.review.prUrl)
          .then(setPrStatus)
          .catch(() => {});
      }

      if (["ready", "stale", "submitted"].includes(r.review.state)) {
        api
          .listPrReviewChat(id)
          .then((res) => setChat(res.messages))
          .catch(() => {});
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to load review");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Auto-refresh while agent is working.
  useEffect(() => {
    if (!review) return;
    const active = ["queued", "waiting_ci", "reviewing"].includes(review.state);
    if (!active && !chatSending) return;
    const t = setInterval(fetchAll, 5000);
    return () => clearInterval(t);
  }, [review?.state, chatSending, fetchAll]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading review...
      </div>
    );
  }
  if (!review) {
    return (
      <div className="flex items-center justify-center h-full text-error">Review not found</div>
    );
  }

  const isEditable = ["ready", "stale"].includes(review.state);
  const isWorking = ["queued", "waiting_ci", "reviewing"].includes(review.state);
  const hasDraft = ["ready", "stale", "submitted"].includes(review.state);
  const prIsOpen = prStatus?.prState === "open";
  const checksOk = prStatus?.checksStatus === "passing" || prStatus?.checksStatus === "none";
  const canMerge = prIsOpen;
  const mergeBlockedReason = !prStatus
    ? "Loading PR status..."
    : !prIsOpen
      ? `PR is ${prStatus.prState}`
      : !checksOk
        ? `CI ${prStatus.checksStatus} — merging anyway`
        : "";

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await api.updatePrReview(id, {
        summary,
        verdict: (verdict as any) || null,
        fileComments: comments,
      });
      setReview(res.review);
      setDirty(false);
      toast.success("Draft saved");
    } catch (err: any) {
      toast.error(err.message || "Failed to save");
    }
    setSaving(false);
  };

  const handleSubmit = async () => {
    if (dirty) await handleSave();
    setSubmitting(true);
    try {
      const res = await api.submitPrReview(id);
      setReview(res.review);
      toast.success("Review submitted");
    } catch (err: any) {
      toast.error(err.message || "Failed to submit");
    }
    setSubmitting(false);
  };

  const handleReReview = async () => {
    setReReviewing(true);
    try {
      await api.reReviewPr(id);
      toast.success("Re-review started");
      await fetchAll();
    } catch (err: any) {
      toast.error(err.message || "Failed to start re-review");
    }
    setReReviewing(false);
  };

  const handleMerge = async () => {
    const warnCi =
      prStatus && !checksOk
        ? `\n\n⚠️  CI is ${prStatus.checksStatus}. GitHub's branch protection may still block the merge.`
        : "";
    if (!confirm(`Merge this PR using ${mergeMethod} strategy?${warnCi}`)) return;
    setMerging(true);
    try {
      await api.mergePullRequest({ prUrl: review.prUrl, mergeMethod });
      toast.success("PR merged");
      setPrStatus((p: any) => (p ? { ...p, prState: "merged" } : p));
    } catch (err: any) {
      toast.error(err.message || "Failed to merge PR");
    }
    setMerging(false);
  };

  const handleCancel = async () => {
    if (!confirm("Cancel this review?")) return;
    try {
      await api.cancelPrReview(id);
      toast.success("Review cancelled");
      await fetchAll();
    } catch (err: any) {
      toast.error(err.message || "Failed to cancel");
    }
  };

  const handleSendChat = async () => {
    if (!chatInput.trim() || chatSending) return;
    const msg = chatInput.trim();
    setChatInput("");
    setChat((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: "user",
        content: msg,
        createdAt: new Date().toISOString(),
      },
    ]);
    setChatSending(true);
    try {
      await api.postPrReviewChat(id, msg);
      toast.success("Sent to agent");
      const start = Date.now();
      const tick = setInterval(async () => {
        const res = await api.listPrReviewChat(id).catch(() => null);
        if (res) {
          setChat(res.messages);
          const hasAssistantReply = res.messages.some(
            (m) => m.role === "assistant" && new Date(m.createdAt).getTime() > start,
          );
          if (hasAssistantReply || Date.now() - start > 300_000) {
            clearInterval(tick);
            setChatSending(false);
            fetchAll();
          }
        }
      }, 3000);
    } catch (err: any) {
      toast.error(err.message || "Failed to send");
      setChatSending(false);
    }
  };

  const updateComment = (i: number, field: string, value: any) => {
    setComments((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: value };
      return next;
    });
    setDirty(true);
  };

  const removeComment = (i: number) => {
    setComments((prev) => prev.filter((_, j) => j !== i));
    setDirty(true);
  };

  const addComment = () => {
    setComments((prev) => [...prev, { path: "", body: "" }]);
    setDirty(true);
  };

  const pipelineCurrent = pipelineCurrentIndex(review.state);
  const terminal =
    review.state === "stale"
      ? { label: "Stale", tone: "error" as const }
      : review.state === "failed"
        ? { label: "Failed", tone: "error" as const }
        : review.state === "cancelled"
          ? { label: "Cancelled", tone: "muted" as const }
          : undefined;

  return (
    <div className="flex flex-col h-full">
      <DetailHeader
        title={`Review: PR #${review.prNumber}`}
        subtitle={
          <>
            <GitPullRequest className="w-3.5 h-3.5" />
            <span>
              {review.repoOwner}/{review.repoName} · #{review.prNumber}
            </span>
            <a
              href={review.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-primary"
            >
              View on {review.prUrl.includes("gitlab") ? "GitLab" : "GitHub"}
              <ExternalLink className="w-3 h-3" />
            </a>
          </>
        }
        state={review.state}
        extraBadges={
          review.origin === "auto" ? (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-primary/10 text-primary">
              <Zap className="w-3 h-3" />
              Auto
            </span>
          ) : null
        }
        metaItems={[
          <>
            <Clock className="w-3 h-3" />
            Updated {formatRelativeTime(review.updatedAt)}
          </>,
        ]}
        rightSlot={
          <>
            {["ready", "stale", "submitted", "failed"].includes(review.state) && (
              <button
                onClick={handleReReview}
                disabled={reReviewing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 disabled:opacity-50"
                title="Launch a fresh review run"
              >
                {reReviewing ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RotateCcw className="w-3 h-3" />
                )}
                Re-review
              </button>
            )}
            {!["cancelled", "submitted"].includes(review.state) && (
              <button
                onClick={handleCancel}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-error/10 text-error text-xs hover:bg-error/20"
              >
                <XCircle className="w-3 h-3" />
                Cancel
              </button>
            )}
            <button
              onClick={fetchAll}
              className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </>
        }
        actions={
          <StatePipelineStrip
            steps={PIPELINE_STEPS}
            current={pipelineCurrent}
            errorAtCurrent={review.state === "stale"}
            terminal={terminal}
          />
        }
      />

      <div className="shrink-0 border-b border-border bg-bg-card px-4 py-2">
        <div className="max-w-5xl mx-auto">
          <PrStatusBar
            checksStatus={prStatus?.checksStatus}
            reviewStatus={prStatus?.reviewStatus}
            prState={prStatus?.prState}
            actions={
              <button
                onClick={() => setShowTimeline(!showTimeline)}
                className={cn(
                  "px-2 py-0.5 rounded text-xs transition-colors",
                  showTimeline ? "bg-primary/10 text-primary" : "text-text-muted hover:bg-bg-hover",
                )}
              >
                Timeline
              </button>
            }
          />
        </div>
      </div>

      {review.errorMessage &&
        review.state === "failed" &&
        (() => {
          const classified = classifyError(review.errorMessage);
          return (
            <div className="shrink-0 border-b border-error/20 bg-error/5">
              <div className="max-w-5xl mx-auto px-4 py-3">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-error shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div>
                      <h3 className="text-sm font-medium text-error">{classified.title}</h3>
                      <p className="text-xs text-error/70 mt-0.5">{classified.description}</p>
                    </div>
                    <div className="p-2.5 rounded-md bg-bg/50 border border-border">
                      <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1">
                        Suggested fix
                      </div>
                      <pre className="text-xs text-text/80 whitespace-pre-wrap font-mono">
                        {classified.remedy}
                      </pre>
                    </div>
                    <div className="flex items-center gap-2">
                      {classified.retryable && (
                        <button
                          onClick={handleReReview}
                          disabled={reReviewing}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50 btn-press transition-all"
                        >
                          <RotateCcw className="w-3 h-3" />
                          Re-review
                        </button>
                      )}
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-error/10 text-error">
                        {classified.category}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

      {review.state === "stale" && (
        <div className="shrink-0 border-b border-warning/20 bg-warning/5 px-4 py-3">
          <div className="max-w-5xl mx-auto flex items-center gap-2 text-sm text-warning">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>The PR has new commits since this review. Consider re-reviewing.</span>
          </div>
        </div>
      )}

      {/* Main content: logs + sidebar — mirrors /tasks/[id] */}
      <div className="flex-1 flex overflow-hidden">
        {/* Log column */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Verdict + summary widget — collapsible. When collapsed, the
              header strip stays visible so the user can see the verdict at a
              glance without expanding. */}
          {hasDraft && (
            <div className="shrink-0 border-b border-border bg-bg-card">
              <button
                onClick={() => setVerdictCollapsed((v) => !v)}
                className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-bg-hover transition-colors"
                title={verdictCollapsed ? "Expand draft" : "Collapse to focus on logs"}
              >
                {verdictCollapsed ? (
                  <ChevronRight className="w-3.5 h-3.5 text-text-muted shrink-0" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-text-muted shrink-0" />
                )}
                <span className="font-medium text-text-muted">Review draft</span>
                {verdict && (
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-medium",
                      verdict === "approve"
                        ? "bg-success/10 text-success"
                        : verdict === "request_changes"
                          ? "bg-error/10 text-error"
                          : "bg-bg text-text-muted",
                    )}
                  >
                    {verdict === "approve"
                      ? "Approve"
                      : verdict === "request_changes"
                        ? "Request changes"
                        : "Comment"}
                  </span>
                )}
                {comments.length > 0 && (
                  <span className="text-[10px] text-text-muted">
                    {comments.length} comment{comments.length === 1 ? "" : "s"}
                  </span>
                )}
                {dirty && <span className="text-[10px] text-warning">• unsaved</span>}
                {verdictCollapsed && summary && (
                  <span className="text-[11px] text-text-muted/70 truncate min-w-0 flex-1 text-left">
                    {summary.split("\n")[0]}
                  </span>
                )}
              </button>
            </div>
          )}
          {hasDraft && !verdictCollapsed && (
            <div className="shrink-0 border-b border-border bg-bg-card max-h-[55vh] overflow-y-auto">
              <div className="max-w-5xl mx-auto px-4 pb-4 space-y-4">
                {/* Verdict */}
                <div>
                  <label className="text-xs font-medium text-text-muted mb-2 block">Verdict</label>
                  <div className="flex gap-2">
                    {[
                      { value: "approve", label: "Approve", Icon: Check, color: "success" },
                      {
                        value: "request_changes",
                        label: "Request Changes",
                        Icon: X,
                        color: "error",
                      },
                      {
                        value: "comment",
                        label: "Comment",
                        Icon: MessageSquare,
                        color: "text-muted",
                      },
                    ].map(({ value, label, Icon, color }) => (
                      <button
                        key={value}
                        disabled={!isEditable}
                        onClick={() => {
                          setVerdict(value);
                          setDirty(true);
                        }}
                        className={cn(
                          "flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                          verdict === value
                            ? `bg-${color}/10 text-${color} border-${color}/30`
                            : "bg-bg border-border text-text-muted hover:bg-bg-hover",
                        )}
                      >
                        <Icon className="w-3.5 h-3.5" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Summary */}
                <div>
                  <label className="text-xs font-medium text-text-muted mb-2 block">
                    Review Summary
                  </label>
                  <textarea
                    value={summary}
                    readOnly={!isEditable}
                    onChange={(e) => {
                      setSummary(e.target.value);
                      setDirty(true);
                    }}
                    rows={5}
                    className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:border-primary focus:ring-1 focus:ring-primary/20 focus:outline-none resize-y disabled:opacity-70"
                    placeholder="Review summary..."
                  />
                </div>

                {/* Inline comments */}
                <div>
                  <label className="text-xs font-medium text-text-muted mb-2 block">
                    Inline Comments ({comments.length})
                  </label>
                  <div className="space-y-2">
                    {comments.map((c, i) => (
                      <div key={i} className="flex gap-2 p-2 rounded-md bg-bg border border-border">
                        <div className="flex-1 space-y-1.5">
                          <div className="flex gap-2">
                            <input
                              value={c.path ?? ""}
                              readOnly={!isEditable}
                              onChange={(e) => updateComment(i, "path", e.target.value)}
                              placeholder="file/path.ts"
                              className="flex-1 px-2 py-1 rounded bg-bg-card border border-border text-xs focus:border-primary focus:outline-none"
                            />
                            <input
                              value={c.line ?? ""}
                              readOnly={!isEditable}
                              onChange={(e) =>
                                updateComment(
                                  i,
                                  "line",
                                  e.target.value ? parseInt(e.target.value) : undefined,
                                )
                              }
                              placeholder="Line"
                              type="text"
                              inputMode="numeric"
                              className="w-20 px-2 py-1 rounded bg-bg-card border border-border text-xs focus:border-primary focus:outline-none"
                            />
                          </div>
                          <textarea
                            value={c.body ?? ""}
                            readOnly={!isEditable}
                            onChange={(e) => updateComment(i, "body", e.target.value)}
                            placeholder="Comment..."
                            rows={2}
                            className="w-full px-2 py-1 rounded bg-bg-card border border-border text-xs focus:border-primary focus:outline-none resize-y"
                          />
                        </div>
                        {isEditable && (
                          <button
                            onClick={() => removeComment(i)}
                            className="text-text-muted hover:text-error transition-colors p-1 self-start"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                    {isEditable && (
                      <button
                        onClick={addComment}
                        className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover"
                      >
                        <Plus className="w-3 h-3" />
                        Add comment
                      </button>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
                  <div className="flex items-center gap-2">
                    {isEditable && dirty && (
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg border border-border text-xs text-text-muted hover:bg-bg-hover disabled:opacity-50"
                      >
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                        Save Draft
                      </button>
                    )}
                    {isEditable && (
                      <button
                        onClick={handleSubmit}
                        disabled={submitting || !verdict}
                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50"
                      >
                        {submitting ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Send className="w-3 h-3" />
                        )}
                        Submit Review
                      </button>
                    )}
                    {review.state === "submitted" && (
                      <span className="inline-flex items-center gap-1 text-xs text-success">
                        <Check className="w-3.5 h-3.5" />
                        Submitted{review.autoSubmitted ? " automatically" : ""}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <div className="flex">
                        <button
                          onClick={handleMerge}
                          disabled={merging || !canMerge}
                          title={mergeBlockedReason || `Merge with ${mergeMethod} strategy`}
                          className={cn(
                            "flex items-center gap-1.5 px-3 py-1.5 rounded-l-md text-xs font-medium border disabled:opacity-50",
                            !checksOk && prIsOpen
                              ? "bg-warning/10 text-warning hover:bg-warning/20 border-warning/30"
                              : "bg-success/10 text-success hover:bg-success/20 border-success/20",
                          )}
                        >
                          {merging ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <GitMerge className="w-3 h-3" />
                          )}
                          {!checksOk && prIsOpen ? "Merge anyway" : "Merge"}
                        </button>
                        <button
                          onClick={() => setMergeMenuOpen((v) => !v)}
                          className={cn(
                            "px-1.5 py-1.5 rounded-r-md text-xs border border-l-0",
                            !checksOk && prIsOpen
                              ? "bg-warning/10 text-warning hover:bg-warning/20 border-warning/30"
                              : "bg-success/10 text-success hover:bg-success/20 border-success/20",
                          )}
                        >
                          <ChevronDown className="w-3 h-3" />
                        </button>
                      </div>
                      {mergeMenuOpen && (
                        <div className="absolute right-0 top-full mt-1 bg-bg-card border border-border rounded-md shadow-lg z-10 py-1 min-w-[140px]">
                          {(["squash", "merge", "rebase"] as const).map((m) => (
                            <button
                              key={m}
                              onClick={() => {
                                setMergeMethod(m);
                                setMergeMenuOpen(false);
                              }}
                              className={cn(
                                "w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover",
                                mergeMethod === m ? "text-primary font-medium" : "text-text",
                              )}
                            >
                              {m === "squash"
                                ? "Squash and merge"
                                : m === "rebase"
                                  ? "Rebase and merge"
                                  : "Create a merge commit"}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Working state hint while there's nothing to show yet */}
          {isWorking && (
            <div className="shrink-0 border-b border-border bg-bg px-4 py-2">
              <div className="max-w-5xl mx-auto flex items-center gap-2 text-xs text-text-muted">
                {review.state === "waiting_ci" ? (
                  <Clock className="w-3.5 h-3.5" />
                ) : (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                )}
                {review.state === "waiting_ci"
                  ? "Waiting for CI to finish — the agent will start reviewing once checks complete."
                  : review.state === "queued"
                    ? "Queued — a worker will pick this up shortly."
                    : "Agent is reviewing the PR. The draft will appear above when it's done."}
              </div>
            </div>
          )}

          {/* Logs */}
          <div className="flex-1 overflow-hidden">
            <ErrorBoundary label="Review log viewer">
              <LogViewer externalLogs={externalLogs} />
            </ErrorBoundary>
          </div>

          {/* Chat composer at the bottom — only when the agent has produced a draft */}
          {hasDraft && (
            <div className="shrink-0 border-t border-border bg-bg-card px-4 py-2.5">
              <ChatTranscript messages={chat} pending={chatSending} />
              <ChatComposer
                value={chatInput}
                onChange={setChatInput}
                onSend={handleSendChat}
                sending={chatSending}
                placeholder="Ask the reviewer a follow-up, or request a change..."
              />
            </div>
          )}
        </div>

        {/* Timeline sidebar — mirrors /tasks/[id] */}
        {showTimeline && (
          <div className="hidden md:flex w-80 shrink-0 border-l border-border overflow-auto bg-bg-card flex-col">
            <div className="flex items-center gap-1 p-2 border-b border-border">
              <span className="px-2.5 py-1 rounded text-xs bg-primary/10 text-primary font-medium">
                Pipeline
              </span>
            </div>
            <div className="flex-1 overflow-auto p-3">
              <ErrorBoundary label="Review pipeline timeline">
                <ReviewPipelineTimeline review={review} runs={runs} />
              </ErrorBoundary>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
