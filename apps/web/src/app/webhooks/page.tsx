"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { Skeleton } from "@/components/skeleton";
import { toast } from "sonner";
import { Webhook, Plus, Trash2, X, Send } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { SectionCard } from "@/components/ui/section-card";
import { Panel } from "@/components/ui/panel";

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
    <div className="rounded-xl border border-border/70 overflow-hidden divide-y divide-border/60">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3.5">
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-16 ml-auto" />
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

  const closeForm = () => {
    setShowForm(false);
    resetForm();
  };

  const newButton = (
    <button
      onClick={() => setShowForm(true)}
      className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
    >
      <Plus className="w-4 h-4" />
      New Webhook
    </button>
  );

  const inputClass =
    "w-full px-3 py-2 text-sm rounded-lg bg-bg border border-border focus:border-primary focus:ring-1 focus:ring-primary/20 outline-none";

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        icon={Webhook}
        title="Webhooks"
        description="Send HTTP POST notifications when tasks or workflow runs change state."
        meta={
          webhooks.length > 0 ? (
            <span>
              {webhooks.length} webhook{webhooks.length === 1 ? "" : "s"} ·{" "}
              {webhooks.filter((w) => w.active).length} active
            </span>
          ) : null
        }
        actions={!showForm && newButton}
      />

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-6">
          <SectionCard
            label="New Webhook"
            hint="Public HTTPS URLs only"
            actions={
              <button
                type="button"
                onClick={closeForm}
                title="Close"
                className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text"
              >
                <X className="w-4 h-4" />
              </button>
            }
            bodyClassName="p-4 space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs text-text-muted mb-1">URL</label>
                <input
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/webhook"
                  className={inputClass + " font-mono"}
                  required
                />
                <p className="text-[11px] text-text-muted mt-1">
                  Private/internal addresses are blocked.
                </p>
              </div>

              <div>
                <label className="block text-xs text-text-muted mb-1">Description (optional)</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Notify Slack on workflow completion"
                  className={inputClass}
                />
              </div>

              <div>
                <label className="block text-xs text-text-muted mb-1">Secret (optional)</label>
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="Shared secret"
                  className={inputClass}
                  autoComplete="new-password"
                />
                <p className="text-[11px] text-text-muted mt-1">
                  Signs deliveries with an HMAC-SHA256{" "}
                  <code className="text-text">X-Optio-Signature</code> header.
                </p>
              </div>
            </div>

            <div className="pt-3 border-t border-border/60">
              <label className="block text-xs text-text-muted mb-2">Events to subscribe to</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {EVENT_GROUPS.map((group) => (
                  <div key={group.label}>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-2">
                      {group.label}
                    </p>
                    <div className="space-y-1.5">
                      {group.events.map((ev) => (
                        <label
                          key={ev.value}
                          className="flex items-center gap-2 text-xs cursor-pointer hover:text-text"
                        >
                          <input
                            type="checkbox"
                            checked={selectedEvents.includes(ev.value)}
                            onChange={() => toggleEvent(ev.value)}
                            className="rounded border-border accent-primary"
                          />
                          <code className="text-text-muted">{ev.label}</code>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 justify-end pt-3 border-t border-border/60">
              <button
                type="button"
                onClick={closeForm}
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
          </SectionCard>
        </form>
      )}

      {loading ? (
        <WebhookTableSkeleton />
      ) : webhooks.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title="No webhooks yet"
          description="Subscribe to Optio events and get an HTTP POST when they fire."
          action={!showForm ? newButton : undefined}
        />
      ) : (
        <div className="rounded-xl border border-border/70 overflow-hidden divide-y divide-border/60">
          {webhooks.map((wh) => (
            <Link
              key={wh.id}
              href={`/webhooks/${wh.id}`}
              className="group grid grid-cols-[auto_minmax(0,2fr)_minmax(0,1.5fr)_auto_auto] gap-x-4 items-center px-4 py-3 bg-bg-card/40 hover:bg-bg-hover/60 transition-colors"
            >
              <span
                className={cn(
                  "w-2 h-2 rounded-full",
                  wh.active ? "bg-success" : "bg-text-muted/40",
                )}
                title={wh.active ? "Active" : "Off"}
              />
              <div className="min-w-0">
                <span className="text-sm font-mono text-text-heading truncate block">{wh.url}</span>
                <span className="text-[11px] text-text-muted truncate block mt-0.5">
                  {wh.active ? "Active" : "Off"}
                  {wh.description && <> · {wh.description}</>}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 min-w-0">
                {wh.events.slice(0, 3).map((ev) => (
                  <span
                    key={ev}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-muted font-mono"
                  >
                    {ev}
                  </span>
                ))}
                {wh.events.length > 3 && (
                  <span className="text-[10px] text-text-muted">+{wh.events.length - 3}</span>
                )}
              </div>
              <span className="text-[11px] text-text-muted tabular-nums">
                {formatRelativeTime(wh.createdAt)}
              </span>
              <div className="flex items-center gap-0.5 justify-end opacity-60 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
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

      <Panel title="Delivery details" className="mt-6">
        <ul className="px-4 py-3 text-xs text-text-muted space-y-1 list-disc list-inside">
          <li>
            Each delivery POSTs JSON to your URL with headers{" "}
            <code className="text-text">X-Optio-Event</code> and optionally{" "}
            <code className="text-text">X-Optio-Signature</code> (HMAC-SHA256).
          </li>
          <li>Slack incoming webhook URLs are auto-detected and sent as formatted Slack blocks.</li>
          <li>Failed deliveries retry up to 3 times with exponential backoff (5s, 10s, 20s).</li>
          <li>10-second request timeout per attempt.</li>
        </ul>
      </Panel>
    </div>
  );
}
