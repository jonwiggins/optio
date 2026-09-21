"use client";

import Link from "next/link";
import type { ComponentType } from "react";
import { AlertTriangle, Bot, Calendar, Loader2, Plus, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkRowView } from "@/components/work-row";
import { countWork, inView, type WorkRow, type WorkView } from "@/lib/work-feed";

/**
 * The overview's centre: one board over the unified work feed. Five
 * tiles (each a saved view of /work), then what's alive right now, then the
 * recurring work and persistent agents that will wake on their own.
 */
export function WorkBoard({ rows, loading }: { rows: WorkRow[]; loading: boolean }) {
  const counts = countWork(rows);
  const active = rows.filter((r) => inView(r, "active")).slice(0, 8);
  const recurring = rows.filter((r) => inView(r, "recurring")).slice(0, 5);
  const agents = rows.filter((r) => inView(r, "agents")).slice(0, 5);

  const tiles: Array<{
    view: WorkView;
    label: string;
    value: number;
    icon: ComponentType<{ className?: string }>;
    tone?: string;
  }> = [
    {
      view: "active",
      label: "Need you",
      value: counts.needsYou,
      icon: AlertTriangle,
      tone: counts.needsYou > 0 ? "text-warning" : undefined,
    },
    {
      view: "active",
      label: "Running",
      value: counts.running,
      icon: Loader2,
      tone: counts.running > 0 ? "text-primary" : undefined,
    },
    {
      view: "active",
      label: "Waiting for you",
      value: counts.waiting,
      icon: Terminal,
      tone: counts.waiting > 0 ? "text-success" : undefined,
    },
    { view: "recurring", label: "Recurring", value: counts.recurring, icon: Calendar },
    { view: "agents", label: "Agents", value: counts.agents, icon: Bot },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {tiles.map((t) => (
          <Link
            key={t.label}
            href={`/work?view=${t.view}`}
            className="rounded-xl border border-border/70 bg-bg-card/50 px-4 py-3 hover:border-primary/40 transition-colors"
          >
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-text-muted/70">
              <t.icon className={cn("w-3 h-3", t.tone)} />
              {t.label}
            </div>
            <div
              className={cn(
                "text-2xl font-semibold tabular-nums mt-1",
                t.tone ?? "text-text-heading",
              )}
            >
              {loading && rows.length === 0 ? "–" : t.value}
            </div>
          </Link>
        ))}
      </div>

      <section className="rounded-xl border border-border/70 overflow-hidden">
        <header className="flex items-center justify-between px-4 py-2.5 bg-bg-card/60 border-b border-border/60">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Active now
          </h2>
          <div className="flex items-center gap-3 text-xs">
            <Link href="/work?view=active" className="text-text-muted hover:text-text">
              All →
            </Link>
            <Link
              href="/work/new"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <Plus className="w-3 h-3" /> New work
            </Link>
          </div>
        </header>
        {active.length === 0 ? (
          <p className="px-4 py-6 text-sm text-text-muted text-center">
            {loading && rows.length === 0
              ? "Loading…"
              : "Nothing running or waiting on you right now."}
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {active.map((r) => (
              <WorkRowView key={r.key} row={r} />
            ))}
          </div>
        )}
      </section>

      {(recurring.length > 0 || agents.length > 0) && (
        <div className="grid md:grid-cols-2 gap-4">
          <MiniList
            title="Recurring"
            href="/work?view=recurring"
            rows={recurring}
            empty="No schedules or event triggers yet."
          />
          <MiniList
            title="Persistent agents"
            href="/work?view=agents"
            rows={agents}
            empty="No persistent agents yet."
          />
        </div>
      )}
    </div>
  );
}

function MiniList({
  title,
  href,
  rows,
  empty,
}: {
  title: string;
  href: string;
  rows: WorkRow[];
  empty: string;
}) {
  return (
    <section className="rounded-xl border border-border/70 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2.5 bg-bg-card/60 border-b border-border/60">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">{title}</h2>
        <Link href={href} className="text-xs text-text-muted hover:text-text">
          All →
        </Link>
      </header>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-xs text-text-muted">{empty}</p>
      ) : (
        <div className="divide-y divide-border/60">
          {rows.map((r) => (
            <WorkRowView key={r.key} row={r} />
          ))}
        </div>
      )}
    </section>
  );
}
