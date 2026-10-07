"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api-client";
import { StateBadge } from "./state-badge";
import { cn, formatRelativeTime } from "@/lib/utils";
import { MessageSquare, Send, Loader2, Pencil, Trash2, X, Check, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

interface ActivityItem {
  type: "comment" | "event" | "message";
  id: string;
  taskId: string;
  createdAt: string;
  // Comment / message fields
  content?: string;
  user?: { id: string; displayName: string; avatarUrl?: string | null };
  // Event fields
  fromState?: string;
  toState?: string;
  trigger?: string;
  message?: string;
  userId?: string;
  // Message fields
  mode?: "soft" | "interrupt";
  deliveredAt?: string | null;
  ackedAt?: string | null;
}

const STATE_DOT_COLORS: Record<string, string> = {
  running: "bg-primary",
  provisioning: "bg-primary",
  queued: "bg-primary/70",
  pending: "bg-text-muted",
  completed: "bg-text-muted/40",
  pr_opened: "bg-success",
  failed: "bg-warning",
  cancelled: "bg-text-muted",
  needs_attention: "bg-success",
};

export function ActivityFeed({ taskId }: { taskId: string }) {
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await api.getTaskActivity(taskId);
      setActivity(res.activity);
    } catch {
      // silent fail
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll for updates every 10 seconds
  useEffect(() => {
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleAddComment = async () => {
    if (!newComment.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.addTaskComment(taskId, newComment.trim());
      setNewComment("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add comment");
    }
    setSubmitting(false);
  };

  const handleUpdate = async (commentId: string) => {
    if (!editContent.trim()) return;
    try {
      await api.updateTaskComment(taskId, commentId, editContent.trim());
      setEditingId(null);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update comment");
    }
  };

  const handleDelete = async (commentId: string) => {
    if (!confirm("Delete this comment?")) return;
    try {
      await api.deleteTaskComment(taskId, commentId);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete comment");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading activity...
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {/* Activity items */}
      {activity.map((item, i) => {
        const isLast = i === activity.length - 1;

        if (item.type === "event") {
          const dotColor = STATE_DOT_COLORS[item.toState ?? ""] ?? "bg-text-muted";
          return (
            <div key={`event-${item.id}`} className="flex items-start gap-3">
              <div className="flex flex-col items-center">
                <div className={cn("w-2 h-2 rounded-full mt-2 shrink-0", dotColor)} />
                {!isLast && <div className="w-px flex-1 mt-1 bg-border/60" />}
              </div>
              <div className="min-w-0 flex-1 pb-4">
                <div className="flex items-center gap-2 flex-wrap">
                  {item.fromState && (
                    <>
                      <StateBadge state={item.fromState} showDot={false} />
                      <span className="text-text-muted/40 text-xs">&rarr;</span>
                    </>
                  )}
                  <StateBadge state={item.toState!} showDot={false} />
                  {item.user && (
                    <span className="text-[11px] text-text-muted/60">
                      by {item.user.displayName}
                    </span>
                  )}
                </div>
                <div className="text-xs text-text-muted/70 mt-1 font-medium">
                  {item.trigger?.replace(/_/g, " ")}
                  {item.message && (
                    <span className="font-normal text-text-muted/50"> &mdash; {item.message}</span>
                  )}
                </div>
                <div className="text-[11px] text-text-muted/40 mt-0.5 tabular-nums">
                  {formatRelativeTime(item.createdAt)}
                </div>
              </div>
            </div>
          );
        }

        // Message item (user → agent)
        if (item.type === "message") {
          const isInterrupt = item.mode === "interrupt";
          const status = item.ackedAt ? "acked" : item.deliveredAt ? "delivered" : "sending";
          return (
            <div key={`message-${item.id}`} className="flex items-start gap-3">
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    "w-2 h-2 rounded-full mt-2 shrink-0",
                    isInterrupt ? "bg-warning" : "bg-primary",
                  )}
                />
                {!isLast && <div className="w-px flex-1 mt-1 bg-border/60" />}
              </div>
              <div className="min-w-0 flex-1 pb-4">
                <div className="rounded-md border border-border bg-primary/5 p-2.5">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5">
                      {isInterrupt ? (
                        <Zap className="w-3 h-3 text-warning" />
                      ) : (
                        <Send className="w-3 h-3 text-primary" />
                      )}
                      <span className="text-xs font-medium text-text">
                        {item.user?.displayName ?? "User"}{" "}
                        <span className="text-text-muted/60 font-normal">
                          {isInterrupt ? "interrupted" : "messaged"} the agent
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "text-[10px] tabular-nums",
                          status === "acked"
                            ? "text-success"
                            : status === "delivered"
                              ? "text-primary"
                              : "text-text-muted/40",
                        )}
                      >
                        {status}
                      </span>
                      <span className="text-[11px] text-text-muted/40 tabular-nums">
                        {formatRelativeTime(item.createdAt)}
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-text/80 whitespace-pre-wrap">{item.content}</p>
                </div>
              </div>
            </div>
          );
        }

        // Comment item
        const isEditing = editingId === item.id;
        return (
          <div key={`comment-${item.id}`} className="flex items-start gap-3">
            <div className="flex flex-col items-center">
              <div className="w-2 h-2 rounded-full mt-2 shrink-0 bg-info" />
              {!isLast && <div className="w-px flex-1 mt-1 bg-border/60" />}
            </div>
            <div className="min-w-0 flex-1 pb-4">
              <div className="rounded-md border border-border bg-bg-card p-2.5">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <MessageSquare className="w-3 h-3 text-info" />
                    <span className="text-xs font-medium text-text">
                      {item.user?.displayName ?? "System"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {item.user && !isEditing && (
                      <>
                        <button
                          onClick={() => {
                            setEditingId(item.id);
                            setEditContent(item.content ?? "");
                          }}
                          className="p-0.5 rounded hover:bg-bg-hover text-text-muted/50 hover:text-text-muted"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="p-0.5 rounded hover:bg-error/10 text-text-muted/50 hover:text-error"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </>
                    )}
                    <span className="text-[11px] text-text-muted/40 tabular-nums">
                      {formatRelativeTime(item.createdAt)}
                    </span>
                  </div>
                </div>
                {isEditing ? (
                  <div className="space-y-1.5">
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className={inputClass({ size: "sm", className: "resize-y" })}
                      rows={3}
                    />
                    <div className="flex gap-1.5">
                      <Button size="sm" onClick={() => handleUpdate(item.id)}>
                        <Check />
                        Save
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setEditingId(null)}>
                        <X />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-text/80 whitespace-pre-wrap">{item.content}</p>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {activity.length === 0 && (
        <div className="text-center text-text-muted/40 text-sm py-6">No activity yet</div>
      )}

      {/* Add comment input */}
      <div className="pt-3 border-t border-border mt-2">
        <div className="flex gap-2">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAddComment();
            }}
            placeholder="Add a comment..."
            rows={2}
            className={inputClass({ size: "sm", className: "flex-1 resize-y" })}
          />
          <Button
            size="sm"
            onClick={handleAddComment}
            disabled={!newComment.trim() || submitting}
            className="self-end"
          >
            {submitting ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        </div>
        <p className="text-[10px] text-text-muted/40 mt-1">Cmd+Enter to submit</p>
      </div>
    </div>
  );
}
