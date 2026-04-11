"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { Skeleton } from "@/components/skeleton";
import { toast } from "sonner";
import { Webhook, Plus, Trash2, X, CheckCircle2, Send } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";

interface WebhookSummary {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// Grouped by category for the create form
const EVENT_GROUPS: { label: string; events: { value: string; label: string }[] }[] = [
  {
    label: "Tasks",
    events: [
      { value: "task.completed", label: "task.completed" },
      { value: "task.failed", label: "task.failed" },
      { value: "task.needs_attention", label: "task.needs_attention" },
      { value: "task.pr_opened", label: "task.pr_opened" },
      { value: "review.completed", label: "review.completed" },
    ],
  },
  {
    label: "Workflow runs",
    events: [
      { value: "workflow_run.queued", label: "workflow_run.queued" },
      { value: "workflow_run.started", label: "workflow_run.started" },
      { value: "workflow_run.completed", label: "workflow_run.completed" },
      { value: "workflow_run.failed", label: "workflow_run.failed" },
    ],
  },
];

function WebhookTableSkeleton() {
  return (
    <div className="rounded-xl border border-border/50 bg-bg-card overflow-hidden">
      <div className="border-b border-border/50 px-4 py-3">
        <Skeleton className="h-4 w-32" />
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-3.5 border-b border-border/30 last:border-b-0"
        >
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

export default function WebhooksPage() {
  usePageTitle("Webhooks");

  const [webhooks, setWebhooks] = useState<WebhookSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Create form state
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [secret, setSecret] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>(["workflow_run.completed"]);

  const load = useCallback(() => {
    api
      .listWebhooks()
      .then((res) => setWebhooks(res.webhooks as WebhookSummary[]))
      .catch(() => toast.error("Failed to load webhooks"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const resetForm = () => {
    setUrl("");
    setDescription("");
    setSecret("");
    setSelectedEvents(["workflow_run.completed"]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return toast.error("URL is required");
    if (selectedEvents.length === 0) return toast.error("Select at least one event");

    setSubmitting(true);
    try {
      await api.createWebhook({
        url: url.trim(),
        events: selectedEvents,
        secret: secret.trim() || undefined,
        description: description.trim() || undefined,
      });
      toast.success("Webhook created");
      resetForm();
      setShowForm(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create webhook");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this webhook? Delivery history will be lost.")) return;
    try {
      await api.deleteWebhook(id);
      toast.success("Webhook deleted");
      load();
    } catch {
      toast.error("Failed to delete webhook");
    }
  };

  const handleTest = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const res = await api.testWebhook(id);
      if (res.delivery.success) {
        toast.success(`Test delivered (HTTP ${res.delivery.statusCode})`);
      } else {
        toast.error(
          `Test failed: ${res.delivery.error ?? `HTTP ${res.delivery.statusCode ?? "?"}`}`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    }
  };

  const toggleEvent = (value: string) => {
    setSelectedEvents((prev) =>
      prev.includes(value) ? prev.filter((e) => e !== value) : [...prev, value],
    );
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
          <p className="text-sm text-text-muted mt-1">
            Send HTTP POST notifications when tasks or workflow runs change state.
          </p>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Webhook
          </button>
        )}
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="mb-6 rounded-xl border border-border/50 bg-bg-card p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">New Webhook</h2>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                resetForm();
              }}
              className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              className="w-full px-3 py-2 text-sm rounded-md bg-bg border border-border focus:border-primary outline-none"
              required
            />
            <p className="text-xs text-text-muted mt-1">
              Must be a public HTTPS URL — private/internal addresses are blocked.
            </p>
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">Description (optional)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Notify Slack on workflow completion"
              className="w-full px-3 py-2 text-sm rounded-md bg-bg border border-border focus:border-primary outline-none"
            />
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">
              Secret (optional — used for HMAC-SHA256 signature header)
            </label>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Shared secret"
              className="w-full px-3 py-2 text-sm rounded-md bg-bg border border-border focus:border-primary outline-none"
              autoComplete="new-password"
            />
            <p className="text-xs text-text-muted mt-1">
              When set, deliveries include <code className="text-text">X-Optio-Signature</code>{" "}
              header.
            </p>
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-2">Events to subscribe to</label>
            <div className="space-y-3">
              {EVENT_GROUPS.map((group) => (
                <div key={group.label} className="rounded-lg border border-border/50 bg-bg p-3">
                  <p className="text-xs font-medium mb-2">{group.label}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {group.events.map((ev) => (
                      <label
                        key={ev.value}
                        className="flex items-center gap-2 text-xs cursor-pointer hover:text-text"
                      >
                        <input
                          type="checkbox"
                          checked={selectedEvents.includes(ev.value)}
                          onChange={() => toggleEvent(ev.value)}
                          className="rounded border-border"
                        />
                        <code className="text-text-muted">{ev.label}</code>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 justify-end pt-2 border-t border-border/50">
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                resetForm();
              }}
              className="px-3 py-1.5 text-sm text-text-muted hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-1.5 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create Webhook"}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <WebhookTableSkeleton />
      ) : webhooks.length === 0 ? (
        <div className="text-center py-16 text-text-muted border border-dashed border-border rounded-lg">
          <Webhook className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p className="font-medium">No webhooks yet</p>
          <p className="text-sm mt-1">
            Subscribe to Optio events and get an HTTP POST when they fire.
          </p>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="text-primary hover:underline text-sm mt-2"
            >
              Create your first webhook
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 bg-bg-card overflow-hidden">
          <div className="grid grid-cols-[2fr_1.5fr_90px_100px_130px] gap-3 px-4 py-2.5 border-b border-border/50 text-xs font-medium text-text-muted uppercase tracking-wider">
            <span>URL</span>
            <span>Events</span>
            <span>Status</span>
            <span>Created</span>
            <span className="text-right">Actions</span>
          </div>
          {webhooks.map((wh) => (
            <Link
              key={wh.id}
              href={`/webhooks/${wh.id}`}
              className="grid grid-cols-[2fr_1.5fr_90px_100px_130px] gap-3 items-center px-4 py-3 border-b border-border/30 last:border-b-0 hover:bg-bg-hover/50 transition-colors"
            >
              <div className="min-w-0">
                <span className="text-sm font-mono truncate block">{wh.url}</span>
                {wh.description && (
                  <span className="text-xs text-text-muted truncate block mt-0.5">
                    {wh.description}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {wh.events.slice(0, 3).map((ev) => (
                  <span
                    key={ev}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-bg text-text-muted font-mono"
                  >
                    {ev}
                  </span>
                ))}
                {wh.events.length > 3 && (
                  <span className="text-[10px] text-text-muted">+{wh.events.length - 3}</span>
                )}
              </div>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full w-fit",
                  wh.active ? "bg-success/10 text-success" : "bg-text-muted/10 text-text-muted",
                )}
              >
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    wh.active ? "bg-success" : "bg-text-muted/50",
                  )}
                />
                {wh.active ? "Active" : "Off"}
              </span>
              <span className="text-xs text-text-muted">{formatRelativeTime(wh.createdAt)}</span>
              <div className="flex items-center gap-1 justify-end">
                <button
                  onClick={(e) => handleTest(wh.id, e)}
                  title="Send test delivery"
                  className="p-1.5 rounded-md hover:bg-primary/10 text-text-muted hover:text-primary transition-colors"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => handleDelete(wh.id, e)}
                  title="Delete webhook"
                  className="p-1.5 rounded-md hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </Link>
          ))}
        </div>
      )}

      <div className="mt-6 rounded-lg border border-border/50 bg-bg-card p-4">
        <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-text-muted" />
          Delivery details
        </h3>
        <ul className="text-xs text-text-muted space-y-1">
          <li>
            Each delivery POSTs JSON to your URL with headers{" "}
            <code className="text-text">X-Optio-Event</code> and optionally{" "}
            <code className="text-text">X-Optio-Signature</code> (HMAC-SHA256).
          </li>
          <li>Slack incoming webhook URLs are auto-detected and sent as formatted Slack blocks.</li>
          <li>Failed deliveries retry up to 3 times with exponential backoff (5s, 10s, 20s).</li>
          <li>10-second request timeout per attempt.</li>
        </ul>
      </div>
    </div>
  );
}
