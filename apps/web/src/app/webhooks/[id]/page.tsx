"use client";

import Link from "next/link";
import { use, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Loader2,
  ArrowLeft,
  Trash2,
  Send,
  Play,
  Pause,
  RefreshCw,
  XCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface WebhookDetail {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  secret: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Delivery {
  id: string;
  webhookId: string;
  event: string;
  payload: Record<string, unknown>;
  statusCode: number | null;
  responseBody: string | null;
  success: boolean;
  attempt: number;
  error: string | null;
  deliveredAt: string;
}

const ALL_EVENTS = [
  "task.completed",
  "task.failed",
  "task.needs_attention",
  "task.pr_opened",
  "review.completed",
  "workflow_run.queued",
  "workflow_run.started",
  "workflow_run.completed",
  "workflow_run.failed",
];

export default function WebhookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [webhook, setWebhook] = useState<WebhookDetail | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [testEvent, setTestEvent] = useState<string>("");
  const [expandedDelivery, setExpandedDelivery] = useState<string | null>(null);

  usePageTitle(webhook?.description ?? "Webhook");

  const refresh = useCallback(async () => {
    try {
      const [wh, deliv] = await Promise.all([
        api.getWebhook(id),
        api.listWebhookDeliveries(id, 50),
      ]);
      setWebhook(wh.webhook as WebhookDetail);
      setDeliveries(deliv.deliveries as Delivery[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load webhook");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggle = async () => {
    if (!webhook) return;
    setActionLoading(true);
    try {
      await api.updateWebhook(id, { active: !webhook.active });
      toast.success(webhook.active ? "Webhook disabled" : "Webhook enabled");
      refresh();
    } catch {
      toast.error("Failed to update");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete this webhook and all delivery history?")) return;
    setActionLoading(true);
    try {
      await api.deleteWebhook(id);
      toast.success("Webhook deleted");
      router.push("/webhooks");
    } catch {
      toast.error("Failed to delete");
      setActionLoading(false);
    }
  };

  const handleTest = async () => {
    setActionLoading(true);
    try {
      const res = await api.testWebhook(id, testEvent || undefined);
      if (res.delivery.success) {
        toast.success(`Test delivered (HTTP ${res.delivery.statusCode})`);
      } else {
        toast.error(
          `Test failed: ${res.delivery.error ?? `HTTP ${res.delivery.statusCode ?? "?"}`}`,
        );
      }
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading webhook...
      </div>
    );
  }

  if (error || !webhook) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link
          href="/webhooks"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Webhooks
        </Link>
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <XCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>{error ?? "Webhook not found"}</p>
        </div>
      </div>
    );
  }

  const successRate =
    deliveries.length > 0
      ? Math.round((deliveries.filter((d) => d.success).length / deliveries.length) * 100)
      : null;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Link
        href="/webhooks"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Webhooks
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "w-2.5 h-2.5 rounded-full shrink-0",
                webhook.active ? "bg-green-500" : "bg-zinc-400",
              )}
            />
            <h1 className="text-xl font-mono font-medium truncate">{webhook.url}</h1>
          </div>
          {webhook.description && (
            <p className="text-sm text-text-muted mt-1">{webhook.description}</p>
          )}
          <div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
            <span>Created {formatRelativeTime(webhook.createdAt)}</span>
            {webhook.secret && <span>• Signed with HMAC-SHA256</span>}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={refresh}
            disabled={actionLoading}
            className="p-2 rounded-md hover:bg-bg-hover text-text-muted hover:text-text transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={handleToggle}
            disabled={actionLoading}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors",
              webhook.active
                ? "hover:bg-warning/10 text-text-muted hover:text-warning"
                : "hover:bg-success/10 text-text-muted hover:text-success",
            )}
          >
            {webhook.active ? (
              <>
                <Pause className="w-4 h-4" /> Disable
              </>
            ) : (
              <>
                <Play className="w-4 h-4" /> Enable
              </>
            )}
          </button>
          <button
            onClick={handleDelete}
            disabled={actionLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-text-muted hover:text-error hover:bg-error/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" /> Delete
          </button>
        </div>
      </div>

      {/* Events + Test */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="rounded-lg border border-border/50 bg-bg-card p-4">
          <h3 className="text-sm font-medium mb-3">Subscribed events</h3>
          <div className="flex flex-wrap gap-1.5">
            {webhook.events.map((ev) => (
              <span
                key={ev}
                className="text-xs px-2 py-0.5 rounded bg-bg text-text-muted font-mono"
              >
                {ev}
              </span>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border/50 bg-bg-card p-4">
          <h3 className="text-sm font-medium mb-3">Send a test delivery</h3>
          <div className="flex items-center gap-2">
            <select
              value={testEvent}
              onChange={(e) => setTestEvent(e.target.value)}
              className="flex-1 px-2 py-1.5 text-xs rounded-md bg-bg border border-border focus:border-primary outline-none"
            >
              <option value="">Default ({webhook.events[0]})</option>
              {ALL_EVENTS.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </select>
            <button
              onClick={handleTest}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" /> Send test
            </button>
          </div>
          <p className="text-xs text-text-muted mt-2">
            Delivers a synthetic sample payload — useful to verify the receiver is reachable.
          </p>
        </div>
      </div>

      {/* Deliveries */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium">Delivery history</h2>
        {successRate != null && (
          <span className="text-xs text-text-muted">
            {deliveries.length} deliveries • {successRate}% success
          </span>
        )}
      </div>

      {deliveries.length === 0 ? (
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <CheckCircle2 className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No deliveries yet</p>
          <p className="text-xs mt-1">
            Fire a test or trigger a subscribed event to see deliveries here.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 bg-bg-card">
                <th className="w-6 px-2 py-2"></th>
                <th className="text-left px-3 py-2 text-xs font-medium text-text-muted">Event</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-text-muted">Status</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-text-muted">Attempt</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-text-muted">When</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-text-muted">Error</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => {
                const expanded = expandedDelivery === d.id;
                return (
                  <>
                    <tr
                      key={d.id}
                      className="border-b border-border/30 last:border-0 cursor-pointer hover:bg-bg-hover/40"
                      onClick={() => setExpandedDelivery(expanded ? null : d.id)}
                    >
                      <td className="px-2 py-2.5 text-text-muted">
                        {expanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs font-mono">{d.event}</td>
                      <td className="px-3 py-2.5">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full",
                            d.success ? "bg-success/10 text-success" : "bg-error/10 text-error",
                          )}
                        >
                          {d.success ? "OK" : "FAIL"}
                          {d.statusCode != null && (
                            <span className="text-[10px] opacity-70">{d.statusCode}</span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-text-muted">{d.attempt}</td>
                      <td className="px-3 py-2.5 text-xs text-text-muted">
                        {formatRelativeTime(d.deliveredAt)}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-error truncate max-w-[220px]">
                        {d.error ? (
                          <span title={d.error}>
                            {d.error.length > 50 ? d.error.slice(0, 50) + "…" : d.error}
                          </span>
                        ) : (
                          "\u2014"
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-border/30 bg-bg-card/60">
                        <td colSpan={6} className="px-4 py-3">
                          <div className="space-y-3">
                            <div>
                              <p className="text-xs text-text-muted mb-1">Payload</p>
                              <pre className="text-xs bg-bg rounded-md p-2 overflow-x-auto whitespace-pre-wrap border border-border/30 max-h-64 overflow-y-auto">
                                {JSON.stringify(d.payload, null, 2)}
                              </pre>
                            </div>
                            {d.responseBody && (
                              <div>
                                <p className="text-xs text-text-muted mb-1">Response body</p>
                                <pre className="text-xs bg-bg rounded-md p-2 overflow-x-auto whitespace-pre-wrap border border-border/30 max-h-40 overflow-y-auto">
                                  {d.responseBody}
                                </pre>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
