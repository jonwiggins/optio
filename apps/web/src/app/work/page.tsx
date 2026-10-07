"use client";

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  CircleAlert,
  Activity,
  Clock3,
  ChevronDown,
  X,
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
import { OwnerSegments } from "@/components/ui/owner-segments";
import { Button, ButtonLink } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { WorkRowView } from "@/components/work-row";
import { countByOwner, inOwnerFilter, parseOwnerFilter, type OwnerFilter } from "@/lib/owner";
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
  const router = useRouter();
  const initial = params.get("view") as WorkView | null;
  const view = VIEWS.some((v) => v.id === initial) ? initial! : "active";
  const focus = params.get("focus");
  const statusFilter = ["needs_you", "running", "waiting"].includes(focus ?? "") ? focus : null;
  const navigate = (nextView: WorkView, nextFocus: string | null = null) => {
    const next = new URLSearchParams(params.toString());
    next.set("view", nextView);
    if (nextFocus) next.set("focus", nextFocus);
    else next.delete("focus");
    router.push(`/work?${next}`, { scroll: false });
  };
  const [q, setQ] = useState("");
  const { rows, loading, error, refetch } = useWorkFeed();
  // Members see the organization's work and their own; an admin also sees
  // other people's private work, read-only. The owner filter appears once a
  // private row is in the list, next to the views (`?owner=`).
  const { userId, canMutate } = useCurrentUser();
  const owner = parseOwnerFilter(params.get("owner"));
  const setOwner = (value: OwnerFilter) => {
    const next = new URLSearchParams(params.toString());
    if (value === "all") next.delete("owner");
    else next.set("owner", value);
    router.replace(`/work?${next}`, { scroll: false });
  };

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

  const scopedRows = useMemo(() => inOwnerFilter(rows, owner, userId), [rows, owner, userId]);
  const counts = useMemo(() => countWork(scopedRows), [scopedRows]);
  const sessionScreen = useMemo(() => sessionScreenTarget(rows), [rows]);
  const sessionsWaiting = rows.filter(
    (r) => r.source === "local-terminal" && r.status === "needs_you",
  ).length;
  const ownerCounts = useMemo(() => countByOwner(rows, userId), [rows, userId]);
  const showOwnerFilter = ownerCounts.private + ownerCounts.others > 0;
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return scopedRows.filter(
      (r) =>
        inView(r, view) &&
        (!statusFilter ||
          (statusFilter === "running"
            ? r.status === "running" || r.status === "queued"
            : statusFilter === "waiting"
              ? r.status === "waiting" && r.source !== "persistent-agent"
              : r.status === statusFilter)) &&
        (!needle ||
          [r.name, r.where.detail, r.who, r.statusLabel, r.note]
            .filter(Boolean)
            .some((s) => String(s).toLowerCase().includes(needle))),
    );
  }, [scopedRows, view, q, statusFilter]);
  const viewCount = (id: WorkView) => scopedRows.filter((r) => inView(r, id)).length;
  const failedTasks = rows.some((r) => r.source === "repo-task" && r.status === "failed");
  const activeTasks = rows.some(
    (r) => r.source === "repo-task" && (r.status === "running" || r.status === "queued"),
  );

  const filtered = !!q.trim() || owner !== "all" || !!statusFilter;
  const clearFilters = () => {
    setQ("");
    const next = new URLSearchParams(params.toString());
    next.delete("owner");
    next.delete("focus");
    router.replace(`/work?${next}`, { scroll: false });
  };
  const summaries = [
    {
      id: "needs_you",
      label: "Needs you",
      value: counts.needsYou,
      icon: CircleAlert,
      hint: "Decisions ready for your input",
      tone: "text-success",
    },
    {
      id: "running",
      label: "In progress",
      value: counts.running,
      icon: Activity,
      hint: "Running or queued to start",
      tone: "text-primary",
    },
    {
      id: "waiting",
      label: "Ready for you",
      value: counts.waiting,
      icon: Clock3,
      hint: "Sessions waiting for your next step",
      tone: "text-success",
    },
  ];

  return (
    <div className="page-column py-6 sm:py-8">
      <PageHeader
        icon={Terminal}
        title="Work"
        description="A clear view of what’s moving and what needs your attention."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={refetch}
              className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
              title="Refresh work"
              aria-label="Refresh work"
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
                    className="min-w-[1.25rem] px-1 rounded-full bg-success/15 text-success text-[11px] tabular-nums text-center"
                  >
                    {sessionsWaiting}
                  </span>
                )}
              </ButtonLink>
            )}
            {canMutate && (
              <ButtonLink href="/work/new">
                <Plus /> New work
              </ButtonLink>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-7" role="group" aria-label="Work summary">
        {summaries.map(({ id, label, value, icon: Icon, hint, tone }) => (
          <button
            key={id}
            type="button"
            aria-pressed={statusFilter === id}
            onClick={() => navigate("active", statusFilter === id ? null : id)}
            className={cn(
              "group rounded-xl border p-3 sm:p-4 text-left transition-colors bg-bg-card/60 hover:bg-bg-card",
              statusFilter === id
                ? "border-primary"
                : "border-border/70 hover:border-border-strong",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[11px] sm:text-xs font-medium text-text-muted">
                <Icon className={cn("hidden sm:block h-4 w-4 shrink-0", tone)} />
                {label}
              </span>
              <ArrowUpRight className="hidden sm:block h-3.5 w-3.5 shrink-0 text-text-muted/60 group-hover:text-text" />
            </div>
            <div className="mt-3">
              <span
                className={cn(
                  "text-3xl font-semibold tracking-tight tabular-nums",
                  id === "needs_you" && value > 0 ? tone : "text-text-heading",
                )}
              >
                {loading || (error && rows.length === 0) ? "—" : value}
              </span>
              <p className="hidden sm:block text-xs text-text-muted mt-1.5">{hint}</p>
            </div>
          </button>
        ))}
      </div>

      <nav
        aria-label="Work views"
        className="flex gap-5 overflow-x-auto border-b border-border mb-5"
      >
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            aria-pressed={view === v.id}
            onClick={() => navigate(v.id)}
            className={cn(
              "shrink-0 flex items-center gap-2 border-b-2 pb-3 pt-1 text-sm transition-colors",
              view === v.id
                ? "border-primary text-text-heading font-medium"
                : "border-transparent text-text-muted hover:text-text",
            )}
          >
            {v.label}
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[11px] tabular-nums",
                view === v.id ? "bg-primary/15 text-text-heading" : "bg-bg-card text-text-muted",
              )}
            >
              {viewCount(v.id)}
            </span>
          </button>
        ))}
      </nav>

      <div className="flex flex-col gap-3 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:flex-1 min-w-0 sm:max-w-sm">
            <Search
              aria-hidden
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted"
            />
            <input
              type="search"
              aria-label="Search work"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search work, places, or agents…"
              className={inputClass({ className: "pl-9 bg-bg-card/60" })}
            />
          </div>
          <span role="status" className="text-xs text-text-muted sm:ml-auto">
            {visible.length} {visible.length === 1 ? "item" : "items"}
          </span>
          {((view === "history" && failedTasks) || (view === "active" && activeTasks)) && (
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-2 text-xs text-text-muted hover:bg-bg-hover [&::-webkit-details-marker]:hidden">
                Task actions <ChevronDown className="h-3.5 w-3.5" />
              </summary>
              <div className="absolute left-0 sm:left-auto sm:right-0 top-full z-20 mt-2 w-64 rounded-xl border border-border bg-bg-card p-3 shadow-xl">
                <p className="mb-3 text-xs leading-relaxed text-text-muted">
                  Applies to all eligible repo tasks, including those outside these filters.
                </p>
                {view === "history" ? (
                  <Button
                    variant="secondary"
                    onClick={retryFailed}
                    disabled={bulkLoading}
                    className="w-full"
                  >
                    <RotateCcw /> Retry all failed tasks
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    onClick={cancelActive}
                    disabled={bulkLoading}
                    className="w-full"
                  >
                    <XCircle /> Cancel all active tasks
                  </Button>
                )}
              </div>
            </details>
          )}
        </div>
        {(showOwnerFilter || filtered) && (
          <div className="flex flex-wrap items-center gap-3">
            {showOwnerFilter && (
              <OwnerSegments
                size="sm"
                rows={rows}
                viewerId={userId}
                value={owner}
                onChange={setOwner}
              />
            )}
            {statusFilter && (
              <button
                onClick={() => navigate(view)}
                className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-text"
              >
                {summaries.find((s) => s.id === statusFilter)?.label}
                <X className="h-3 w-3" aria-hidden />
                <span className="sr-only">Remove status filter</span>
              </button>
            )}
            {filtered && (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-error/30 bg-error/5 p-4"
        >
          <div>
            <p className="text-sm font-medium text-error">Couldn’t refresh work</p>
            <p className="mt-1 text-xs text-text-muted">
              {rows.length ? "Showing the last available results. " : ""}
              {error}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={refetch}>
            Try again
          </Button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-14 skeleton-shimmer rounded-lg" />
          ))}
        </div>
      ) : error && rows.length === 0 ? null : visible.length === 0 ? (
        <EmptyState
          icon={Terminal}
          title={
            filtered
              ? "No matching work"
              : view === "active"
                ? "You’re all caught up"
                : "Nothing here yet"
          }
          description={
            filtered
              ? "Try another search or clear your filters to see more work."
              : view === "active"
                ? "Running work and sessions that need you will appear here. Start something new, or check your recurring work."
                : "Start a task, schedule an automation, or give an agent something to do."
          }
          action={
            filtered ? (
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : canMutate ? (
              <ButtonLink href="/work/new">
                <Plus /> New work
              </ButtonLink>
            ) : undefined
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
