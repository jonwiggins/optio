"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Loader2,
  Check,
  X,
  MessageSquare,
  Send,
  AlertTriangle,
  RefreshCw,
  GitMerge,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  ExternalLink,
} from "lucide-react";

interface ReviewDraftPanelProps {
  taskId: string;
  taskState: string;
}

export function ReviewDraftPanel({ taskId, taskState }: ReviewDraftPanelProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [reReviewing, setReReviewing] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<"squash" | "merge" | "rebase">("squash");
  const [showMergeDropdown, setShowMergeDropdown] = useState(false);
  const [prStatus, setPrStatus] = useState<any>(null);
  const [showFileComments, setShowFileComments] = useState(true);

  // Editable fields
  const [editedSummary, setEditedSummary] = useState("");
  const [editedVerdict, setEditedVerdict] = useState<string>("");
  const [editedComments, setEditedComments] = useState<any[]>([]);
  const [hasEdits, setHasEdits] = useState(false);

  const fetchDraft = useCallback(async () => {
    try {
      const res = await api.getReviewDraft(taskId);
      setDraft(res.draft);
      if (res.draft) {
        setEditedSummary(res.draft.summary ?? "");
        setEditedVerdict(res.draft.verdict ?? "");
        setEditedComments(res.draft.fileComments ?? []);
        setHasEdits(false);

        // Fetch PR status for the merge button
        if (["ready", "stale"].includes(res.draft.state)) {
          api
            .getPrStatus(res.draft.prUrl)
            .then(setPrStatus)
            .catch(() => {});
        }
      }
    } catch {
      // Draft may not exist yet
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    fetchDraft();
  }, [fetchDraft, taskState]);

  // Auto-refresh while drafting
  useEffect(() => {
    if (draft?.state !== "drafting") return;
    const interval = setInterval(fetchDraft, 5000);
    return () => clearInterval(interval);
  }, [draft?.state, fetchDraft]);

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await api.updateReviewDraft(taskId, {
        summary: editedSummary,
        verdict: editedVerdict,
        fileComments: editedComments,
      });
      setDraft(res.draft);
      setHasEdits(false);
      toast.success("Draft saved");
    } catch (err: any) {
      toast.error(err.message || "Failed to save draft");
    }
    setSaving(false);
  };

  const handleSubmit = async () => {
    if (!draft) return;
    // Save pending edits first
    if (hasEdits) await handleSave();
    setSubmitting(true);
    try {
      const res = await api.submitReviewDraft(taskId);
      setDraft(res.draft);
      toast.success("Review submitted to GitHub");
    } catch (err: any) {
      toast.error(err.message || "Failed to submit review");
    }
    setSubmitting(false);
  };

  const handleReReview = async () => {
    setReReviewing(true);
    try {
      const res = await api.reReview(taskId);
      toast.success("Re-review started");
      router.push(`/tasks/${res.task.id}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to start re-review");
    }
    setReReviewing(false);
  };

  const handleMerge = async () => {
    if (!draft) return;
    if (!confirm(`Merge this PR using ${mergeMethod} strategy?`)) return;
    setMerging(true);
    try {
      await api.mergePullRequest({
        prUrl: draft.prUrl,
        mergeMethod,
      });
      toast.success("PR merged successfully");
      setPrStatus((prev: any) => (prev ? { ...prev, prState: "merged" } : prev));
    } catch (err: any) {
      toast.error(err.message || "Failed to merge PR");
    }
    setMerging(false);
  };

  const updateComment = (index: number, field: string, value: any) => {
    setEditedComments((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
    setHasEdits(true);
  };

  const removeComment = (index: number) => {
    setEditedComments((prev) => prev.filter((_, i) => i !== index));
    setHasEdits(true);
  };

  const addComment = () => {
    setEditedComments((prev) => [...prev, { path: "", line: undefined, body: "" }]);
    setHasEdits(true);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading review draft...
      </div>
    );
  }

  if (!draft) return null;

  // ── Drafting state ────────────────────────────────────────────────────────
  if (draft.state === "drafting") {
    return (
      <div className="rounded-lg border border-border bg-bg-card p-4 mb-4">
        <div className="flex items-center gap-2 text-warning text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="font-medium">Agent is reviewing the PR...</span>
        </div>
        <p className="text-xs text-text-muted mt-1">
          The review draft will appear here when the agent finishes. You can watch progress in the
          logs below.
        </p>
      </div>
    );
  }

  // ── Submitted state ───────────────────────────────────────────────────────
  if (draft.state === "submitted") {
    return (
      <div className="rounded-lg border border-border bg-bg-card p-4 mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-success" />
            <span className="text-sm font-medium text-success">Review Submitted</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-success/10 text-success">
              {draft.verdict === "approve"
                ? "Approved"
                : draft.verdict === "request_changes"
                  ? "Changes Requested"
                  : "Commented"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={draft.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              View on GitHub
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
        {draft.summary && (
          <div className="mt-3 p-3 rounded-md bg-bg text-sm text-text-muted whitespace-pre-wrap">
            {draft.summary}
          </div>
        )}
      </div>
    );
  }

  // ── Ready / Stale state (editable) ────────────────────────────────────────
  const checksOk = prStatus?.checksStatus === "passing" || prStatus?.checksStatus === "none";
  const canMerge = checksOk && prStatus?.prState === "open";

  return (
    <div className="rounded-lg border border-border bg-bg-card p-4 mb-4 space-y-4">
      {/* Stale banner */}
      {draft.state === "stale" && (
        <div className="flex items-center justify-between gap-2 p-3 rounded-md bg-warning/10 border border-warning/20">
          <div className="flex items-center gap-2 text-warning text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>The PR has new commits since this review. Consider re-reviewing.</span>
          </div>
          <button
            onClick={handleReReview}
            disabled={reReviewing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-warning text-white text-xs font-medium hover:bg-warning/90 disabled:opacity-50 shrink-0"
          >
            {reReviewing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Re-review
          </button>
        </div>
      )}

      {/* Verdict selector */}
      <div>
        <label className="text-xs font-medium text-text-muted mb-2 block">Verdict</label>
        <div className="flex gap-2">
          {[
            { value: "approve", label: "Approve", icon: Check, color: "success" },
            { value: "request_changes", label: "Request Changes", icon: X, color: "error" },
            { value: "comment", label: "Comment", icon: MessageSquare, color: "text-muted" },
          ].map(({ value, label, icon: Icon, color }) => (
            <button
              key={value}
              onClick={() => {
                setEditedVerdict(value);
                setHasEdits(true);
              }}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium border transition-colors",
                editedVerdict === value
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
        <label className="text-xs font-medium text-text-muted mb-2 block">Review Summary</label>
        <textarea
          value={editedSummary}
          onChange={(e) => {
            setEditedSummary(e.target.value);
            setHasEdits(true);
          }}
          rows={6}
          className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:border-primary focus:ring-1 focus:ring-primary/20 focus:outline-none resize-y"
          placeholder="Review summary..."
        />
      </div>

      {/* File comments */}
      <div>
        <button
          onClick={() => setShowFileComments(!showFileComments)}
          className="flex items-center gap-1.5 text-xs font-medium text-text-muted mb-2"
        >
          {showFileComments ? (
            <ChevronUp className="w-3 h-3" />
          ) : (
            <ChevronDown className="w-3 h-3" />
          )}
          Inline Comments ({editedComments.length})
        </button>

        {showFileComments && (
          <div className="space-y-2">
            {editedComments.map((comment, i) => (
              <div key={i} className="flex gap-2 p-2 rounded-md bg-bg border border-border">
                <div className="flex-1 space-y-1.5">
                  <div className="flex gap-2">
                    <input
                      value={comment.path ?? ""}
                      onChange={(e) => updateComment(i, "path", e.target.value)}
                      placeholder="file/path.ts"
                      className="flex-1 px-2 py-1 rounded bg-bg-card border border-border text-xs focus:border-primary focus:outline-none"
                    />
                    <input
                      value={comment.line ?? ""}
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
                    value={comment.body ?? ""}
                    onChange={(e) => updateComment(i, "body", e.target.value)}
                    placeholder="Comment..."
                    rows={2}
                    className="w-full px-2 py-1 rounded bg-bg-card border border-border text-xs focus:border-primary focus:outline-none resize-y"
                  />
                </div>
                <button
                  onClick={() => removeComment(i)}
                  className="text-text-muted hover:text-error transition-colors p-1 self-start"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button
              onClick={addComment}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary-hover transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add comment
            </button>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between gap-3 pt-2 border-t border-border">
        <div className="flex items-center gap-2">
          {/* Save */}
          {hasEdits && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-bg border border-border text-xs text-text-muted hover:bg-bg-hover disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Save Draft
            </button>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={submitting || !editedVerdict}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
          >
            {submitting ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Send className="w-3 h-3" />
            )}
            Submit Review
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* CI status indicator */}
          {prStatus && (
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              <span
                className={cn(
                  "w-2 h-2 rounded-full",
                  prStatus.checksStatus === "passing"
                    ? "bg-success"
                    : prStatus.checksStatus === "failing"
                      ? "bg-error"
                      : prStatus.checksStatus === "pending"
                        ? "bg-warning animate-pulse"
                        : "bg-text-muted/30",
                )}
              />
              CI: {prStatus.checksStatus}
            </div>
          )}

          {/* Merge button with strategy dropdown */}
          <div className="relative">
            <div className="flex">
              <button
                onClick={handleMerge}
                disabled={merging || !canMerge}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-l-md bg-success/10 text-success text-xs font-medium hover:bg-success/20 disabled:opacity-50 transition-colors border border-success/20"
              >
                {merging ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <GitMerge className="w-3 h-3" />
                )}
                Merge
              </button>
              <button
                onClick={() => setShowMergeDropdown(!showMergeDropdown)}
                className="px-1.5 py-1.5 rounded-r-md bg-success/10 text-success text-xs hover:bg-success/20 border border-l-0 border-success/20"
              >
                <ChevronDown className="w-3 h-3" />
              </button>
            </div>
            {showMergeDropdown && (
              <div className="absolute right-0 top-full mt-1 bg-bg-card border border-border rounded-md shadow-lg z-10 py-1 min-w-[140px]">
                {(["squash", "merge", "rebase"] as const).map((method) => (
                  <button
                    key={method}
                    onClick={() => {
                      setMergeMethod(method);
                      setShowMergeDropdown(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-bg-hover",
                      mergeMethod === method ? "text-primary font-medium" : "text-text",
                    )}
                  >
                    {method === "squash"
                      ? "Squash and merge"
                      : method === "rebase"
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
  );
}
