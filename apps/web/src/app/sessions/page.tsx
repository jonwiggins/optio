"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus, RefreshCw, Search, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import { useSessionsFeed } from "@/hooks/use-sessions-feed";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { SessionRowView } from "@/components/session-row";
import { countSessions, inView, type SessionView } from "@/lib/sessions-feed";

/**
 * The one list. Every kind of work — PR tasks, jobs, automations, terminals,
 * pod sessions, persistent agents — as rows with the same five attributes.
 * Views are saved filters; the default is what's alive right now.
 */

const VIEWS: Array<{ id: SessionView; label: string }> = [
  { id: "active", label: "Active" },
  { id: "recurring", label: "Recurring" },
  { id: "agents", label: "Agents" },
  { id: "history", label: "History" },
  { id: "all", label: "All" },
];

export default function SessionsPage() {
  usePageTitle("Sessions");
  return (
    <Suspense fallback={<div className="p-6 max-w-6xl mx-auto h-32 skeleton-shimmer rounded-lg" />}>
      <SessionsList />
    </Suspense>
  );
}

function SessionsList() {
  const params = useSearchParams();
  const initial = (params.get("view") as SessionView | null) ?? "active";
  const [view, setView] = useState<SessionView>(
    VIEWS.some((v) => v.id === initial) ? initial : "active",
  );
  const [q, setQ] = useState("");
  const { rows, loading, error, refetch } = useSessionsFeed();

  const counts = useMemo(() => countSessions(rows), [rows]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        inView(r, view) &&
        (!needle ||
          [r.name, r.where.detail, r.who, r.statusLabel, r.note]
            .filter(Boolean)
            .some((s) => String(s).toLowerCase().includes(needle))),
    );
  }, [rows, view, q]);
  const viewCount = (id: SessionView) => rows.filter((r) => inView(r, id)).length;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        icon={Terminal}
        title="Sessions"
        description="Everything Optio is running, waiting on, or will run — one list, filtered by what matters now."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={refetch}
              className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
              title="Refresh"
            >
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
            <Link
              href="/sessions/new"
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
            >
              <Plus className="w-4 h-4" /> New session
            </Link>
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
        <div className="flex gap-1 p-1 rounded-lg bg-bg-card border border-border w-fit">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors",
                view === v.id ? "bg-primary text-white" : "text-text-muted hover:text-text",
              )}
            >
              {v.label}
              <span
                className={cn(
                  "text-[10px] tabular-nums px-1 rounded",
                  view === v.id ? "bg-white/20" : "bg-bg text-text-muted/70",
                )}
              >
                {viewCount(v.id)}
              </span>
            </button>
          ))}
        </div>
        <div className="relative sm:ml-auto sm:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, place, agent…"
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
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
              : q
                ? "No sessions match"
                : "No sessions here yet"
          }
          description={
            view === "active"
              ? "Running, queued, and waiting sessions show up here. Recurring ones live under their own view until they fire."
              : "Start something — a PR, a chat on your machine, a schedule, or a persistent agent."
          }
          action={
            <Link
              href="/sessions/new"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover"
            >
              <Plus className="w-4 h-4" /> New session
            </Link>
          }
        />
      ) : (
        <div className="rounded-xl border border-border/70 overflow-hidden divide-y divide-border/60">
          {visible.map((r) => (
            <SessionRowView key={r.key} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}
