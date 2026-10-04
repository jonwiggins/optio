"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SquareTerminal,
  Terminal,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useWorkFeed } from "@/hooks/use-work-feed";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Segmented } from "@/components/ui/segmented";
import { OwnerSegments, useOwnerFilter } from "@/components/ui/owner-segments";
import { Button, ButtonLink } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { WorkRowView } from "@/components/work-row";
import { countByOwner, inOwnerFilter } from "@/lib/owner";
import { countWork, inView, sessionScreenTarget, type WorkView } from "@/lib/work-feed";

/**
 * The one list. Every kind of work — PR tasks, jobs, automations, terminals,
 * pod sessions, persistent agents — as rows with the same five attributes.
 * Views are saved filters; the default is what's alive right now.
 */

const VIEWS: Array<{ id: WorkView; label: string }> = [
  { id: "active", label: "Active" },
  { id: "recurring", label: "Recurring" },
  { id: "agents", label: "Agents" },
  { id: "history", label: "History" },
  { id: "all", label: "All" },
];

export default function WorkPage() {
  usePageTitle("Work");
  return (
    <Suspense fallback={<div className="page-column py-6 h-32 skeleton-shimmer rounded-lg" />}>
      <WorkList />
    </Suspense>
  );
}

function WorkList() {
  const params = useSearchParams();
  const initial = (params.get("view") as WorkView | null) ?? "active";
  const [view, setView] = useState<WorkView>(
    VIEWS.some((v) => v.id === initial) ? initial : "active",
  );
  const [q, setQ] = useState("");
  const { rows, loading, error, refetch } = useWorkFeed();
  // Members see the organization's work and their own; an admin also sees
  // other people's private work, read-only. The owner filter appears once a
  // private row is in the list, next to the views (`?owner=`).
  const { userId } = useCurrentUser();
  const [owner, setOwner] = useOwnerFilter();

  // Bulk actions inherited from the retired /tasks list. They only touch
  // repo tasks, so they're offered on the views where those rows sit.
  const [bulkLoading, setBulkLoading] = useState(false);
  const runBulk = async (confirmText: string, fn: () => Promise<string>) => {
    if (!confirm(confirmText)) return;
    setBulkLoading(true);
    try {
      toast.success(await fn());
      refetch();
    } catch {
      toast.error("Bulk action failed");
    } finally {
      setBulkLoading(false);
    }
  };
  const retryFailed = () =>
    runBulk("Retry all failed tasks?", async () => {
      const res = await api.bulkRetryFailed();
      return `Retried ${res.retried} of ${res.total} failed tasks`;
    });
  const cancelActive = () =>
    runBulk("Cancel all running and queued tasks?", async () => {
      const res = await api.bulkCancelActive();
      return `Cancelled ${res.cancelled} of ${res.total} active tasks`;
    });

  const counts = useMemo(() => countWork(rows), [rows]);
  const sessionScreen = useMemo(() => sessionScreenTarget(rows), [rows]);
  const sessionsWaiting = rows.filter(
    (r) => r.source === "local-terminal" && r.status === "needs_you",
  ).length;
  const ownerCounts = useMemo(() => countByOwner(rows, userId), [rows, userId]);
  const showOwnerFilter = ownerCounts.private + ownerCounts.others > 0;
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return inOwnerFilter(rows, owner, userId).filter(
      (r) =>
        inView(r, view) &&
        (!needle ||
          [r.name, r.where.detail, r.who, r.statusLabel, r.note]
            .filter(Boolean)
            .some((s) => String(s).toLowerCase().includes(needle))),
    );
  }, [rows, view, q, owner, userId]);
  const viewCount = (id: WorkView) => rows.filter((r) => inView(r, id)).length;
  const failedTasks = rows.some((r) => r.source === "repo-task" && r.status === "failed");
  const activeTasks = rows.some(
    (r) => r.source === "repo-task" && (r.status === "running" || r.status === "queued"),
  );

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={Terminal}
        title="Work"
        description="Everything Optio is running, waiting on, or will run — one list, filtered by what matters now."
        actions={
          <div className="flex items-center gap-2">
            {view === "history" && failedTasks && (
              <Button variant="secondary" onClick={retryFailed} disabled={bulkLoading}>
                <RotateCcw /> Retry failed
              </Button>
            )}
            {view === "active" && activeTasks && (
              <Button
                variant="secondary"
                onClick={cancelActive}
                disabled={bulkLoading}
                className="hover:text-error hover:bg-error/5"
              >
                <XCircle /> Cancel active
              </Button>
            )}
            <button
              onClick={refetch}
              className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
              title="Refresh"
            >
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
            {sessionScreen && (
              <ButtonLink
                variant="secondary"
                href={sessionScreen.href}
                title={
                  sessionScreen.status === "needs_you"
                    ? `Open the session screen at "${sessionScreen.name}", which is waiting on you`
                    : "Open the session screen — every session on your machines, one click apart"
                }
              >
                <SquareTerminal /> Sessions
                {sessionsWaiting > 0 && (
                  <span
                    title={`${sessionsWaiting} waiting on you`}
                    className="min-w-[1.25rem] px-1 rounded-full bg-warning/15 text-warning text-[11px] tabular-nums text-center"
                  >
                    {sessionsWaiting}
                  </span>
                )}
              </ButtonLink>
            )}
            <ButtonLink href="/work/new">
              <Plus /> New work
            </ButtonLink>
          </div>
        }
        meta={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
            {counts.needsYou > 0 && (
              <span className="text-warning">
                {counts.needsYou} need{counts.needsYou === 1 ? "s" : ""} you
              </span>
            )}
            <span>
              {counts.running} running · {counts.waiting} waiting · {counts.recurring} recurring ·{" "}
              {counts.agents} agent{counts.agents === 1 ? "" : "s"}
            </span>
          </div>
        }
      />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            size="md"
            surface="card"
            className="gap-1"
            value={view}
            onChange={setView}
            options={VIEWS.map((v) => ({ value: v.id, label: v.label, count: viewCount(v.id) }))}
          />
          {showOwnerFilter && (
            <OwnerSegments
              size="sm"
              rows={rows}
              viewerId={userId}
              value={owner}
              onChange={setOwner}
            />
          )}
        </div>
        <div className="relative sm:ml-auto sm:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, place, agent…"
            className={inputClass({ size: "sm", className: "pl-8 bg-bg-card" })}
          />
        </div>
      </div>

      {error && <p className="text-sm text-error mb-3">{error}</p>}

      {loading && rows.length === 0 ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-14 skeleton-shimmer rounded-lg" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Terminal}
          title={
            view === "active"
              ? "Nothing needs you right now"
              : q || owner !== "all"
                ? "Nothing matches"
                : "Nothing here yet"
          }
          description={
            view === "active"
              ? "Running, queued, and waiting work shows up here. Recurring work lives under its own view until it fires."
              : "Start something — a PR, a chat on your machine, a schedule, or a persistent agent."
          }
          action={
            <ButtonLink href="/work/new">
              <Plus /> New work
            </ButtonLink>
          }
        />
      ) : (
        <div className="rounded-xl border border-border/70 overflow-hidden divide-y divide-border/60">
          {visible.map((r) => (
            <WorkRowView key={r.key} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}
