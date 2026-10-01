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
  Clock,
  Globe,
  ShieldCheck,
} from "lucide-react";
import { DetailHeader } from "@/components/detail-header";
import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/ui/panel";
import { SectionCard } from "@/components/ui/section-card";

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
    <>
      <DetailHeader
        title={webhook.description || hostOf(webhook.url)}
        subtitle={
          <Link href="/webhooks" className="inline-flex items-center gap-1 hover:text-primary">
            <ArrowLeft className="w-3 h-3" />
            Webhooks
          </Link>
        }
        state={webhook.active ? "enabled" : "disabled"}
        metaItems={[
          <span key="url" className="inline-flex items-center gap-1 font-mono min-w-0">
            <Globe className="w-3 h-3 shrink-0" />
            <span className="truncate max-w-[32rem]" title={webhook.url}>
              {webhook.url}
            </span>
          </span>,
          <>
            <Clock className="w-3 h-3" />
            Created {formatRelativeTime(webhook.createdAt)}
          </>,
          ...(webhook.secret
            ? [
                <span key="signed" className="inline-flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" />
                  Signed with HMAC-SHA256
                </span>,
              ]
            : []),
        ]}
        rightSlot={
          <button
            onClick={refresh}
            disabled={actionLoading}
            className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        }
        actions={
          <>
            <button
              onClick={handleToggle}
              disabled={actionLoading}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors",
                webhook.active
                  ? "bg-warning/10 text-warning hover:bg-warning/20"
                  : "bg-success/10 text-success hover:bg-success/20",
              )}
            >
              {webhook.active ? (
                <>
                  <Pause className="w-3 h-3" /> Disable
                </>
              ) : (
                <>
                  <Play className="w-3 h-3" /> Enable
                </>
              )}
            </button>
            <button
              onClick={handleDelete}
              disabled={actionLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 transition-colors"
            >
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          </>
        }
      />

      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SectionCard
            label="Subscribed events"
            summary={`${webhook.events.length} event${webhook.events.length === 1 ? "" : "s"}`}
          >
            <div className="flex flex-wrap gap-1.5">
              {webhook.events.map((ev) => (
                <span
                  key={ev}
                  className="text-xs px-2 py-0.5 rounded-md bg-bg border border-border/60 text-text-muted font-mono"
                >
                  {ev}
                </span>
              ))}
            </div>
          </SectionCard>

          <SectionCard label="Send a test delivery">
            <div className="flex items-center gap-2">
              <select
                value={testEvent}
                onChange={(e) => setTestEvent(e.target.value)}
                aria-label="Test event"
                className="flex-1 min-w-0 px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors"
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
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" /> Send test
              </button>
            </div>
            <p className="text-xs text-text-muted mt-2">
              Delivers a synthetic sample payload — useful to verify the receiver is reachable.
            </p>
          </SectionCard>
        </div>

        {deliveries.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="No deliveries yet"
            description="Fire a test or trigger a subscribed event to see deliveries here."
          />
        ) : (
          <Panel
            title="Delivery history"
            actions={
              successRate != null && (
                <span className="text-text-muted">
                  {deliveries.length} deliveries · {successRate}% success
                </span>
              )
            }
          >
            <div className="divide-y divide-border/60">
              {deliveries.map((d) => {
                const expanded = expandedDelivery === d.id;
                return (
                  <div key={d.id} className="bg-bg-card/40">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setExpandedDelivery(expanded ? null : d.id)}
                      className="w-full grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-bg-hover/60 transition-colors"
                    >
                      <span
                        className={cn(
                          "w-2 h-2 rounded-full",
                          d.success ? "bg-success" : "bg-error",
                        )}
                        aria-label={d.success ? "Delivered" : "Failed"}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium font-mono text-text-heading truncate">
                          {d.event}
                        </div>
                        <div className="text-[11px] text-text-muted truncate">
                          <span className={d.success ? "text-success" : "text-error"}>
                            {d.success ? "OK" : "Failed"}
                          </span>
                          {d.statusCode != null && <span> · HTTP {d.statusCode}</span>}
                          {d.attempt > 1 && <span> · attempt {d.attempt}</span>}
                        </div>
                      </div>
                      <div className="col-span-3 sm:col-span-1 text-[11px] text-error truncate min-w-0">
                        {d.error ? <span title={d.error}>{d.error}</span> : null}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-text-muted/70 whitespace-nowrap">
                        {formatRelativeTime(d.deliveredAt)}
                        {expanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </div>
                    </button>
                    {expanded && (
                      <div className="px-4 pb-4 pl-10 space-y-3">
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
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
