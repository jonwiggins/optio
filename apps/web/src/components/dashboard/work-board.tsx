"use client";

import Link from "next/link";
import type { ComponentType } from "react";
import { AlertTriangle, Bot, Calendar, Loader2, Plus, Terminal } from "lucide-react";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import { StatTile } from "@/components/ui/stat-tile";
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
          <StatTile
            key={t.label}
            href={`/work?view=${t.view}`}
            label={t.label}
            icon={t.icon}
            tone={t.tone}
            value={loading && rows.length === 0 ? "–" : t.value}
          />
        ))}
      </div>

      <Panel
        title="Active now"
        actions={
          <>
            <Link href="/work?view=active" className="text-text-muted hover:text-text">
              All →
            </Link>
            <Link
              href="/work/new"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <Plus className="w-3 h-3" /> New work
            </Link>
          </>
        }
      >
        {active.length === 0 ? (
          <PanelEmpty className="py-6 text-sm text-center">
            {loading && rows.length === 0
              ? "Loading…"
              : "Nothing running or waiting on you right now."}
          </PanelEmpty>
        ) : (
          <div className="divide-y divide-border/60">
            {active.map((r) => (
              <WorkRowView key={r.key} row={r} />
            ))}
          </div>
        )}
      </Panel>

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
    <Panel
      title={title}
      actions={
        <Link href={href} className="text-text-muted hover:text-text">
          All →
        </Link>
      }
    >
      {rows.length === 0 ? (
        <PanelEmpty>{empty}</PanelEmpty>
      ) : (
        <div className="divide-y divide-border/60">
          {rows.map((r) => (
            <WorkRowView key={r.key} row={r} />
          ))}
        </div>
      )}
    </Panel>
  );
}
