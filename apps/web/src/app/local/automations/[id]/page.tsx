"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Activity,
  ArrowLeft,
  Bot,
  Clock,
  DollarSign,
  Hash,
  Laptop,
  Loader2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatDuration, formatRelativeTime } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import { DetailHeader } from "@/components/detail-header";
import { MetadataCard } from "@/components/metadata-card";
import { EmptyState } from "@/components/empty-state";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import { Button, ButtonLink } from "@/components/ui/button";
import { triggerSummary } from "@/components/local/automations-section";
import { TriggerIcon } from "@/components/brand-icon";
import { shortDir } from "@/lib/work-feed";

/**
 * A Local automation's page: what it is, how it has been doing, and every
 * session it has spawned — the counterpart of `/jobs/:id` and
 * `/tasks/scheduled/:id` for the third recurring kind. Its five answers are
 * edited at /work/:id/edit.
 */

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "OpenAI Codex",
  cursor: "Cursor",
  gemini: "Google Gemini",
  opencode: "OpenCode",
};

function runState(t: any): { label: string; dot: string; tone: string } {
  if (t.state === "error") return { label: "error", dot: "bg-error", tone: "text-error" };
  if (t.state === "exited")
    return t.exitCode === 0 || t.exitCode == null
      ? { label: "exited", dot: "bg-text-muted/40", tone: "" }
      : { label: `exit ${t.exitCode}`, dot: "bg-error", tone: "text-error" };
  if (t.state === "pending" || t.state === "launching")
    return { label: t.state, dot: "bg-warning/70", tone: "" };
  if (t.attentionState === "needs_you")
    return { label: "needs you", dot: "bg-warning", tone: "text-warning" };
  if (t.attentionState === "idle") return { label: "idle", dot: "bg-success", tone: "" };
  return { label: "working", dot: "bg-primary animate-pulse", tone: "text-primary" };
}

export default function LocalAutomationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [blueprint, setBlueprint] = useState<any>(null);
  const [triggers, setTriggers] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [hosts, setHosts] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  usePageTitle(blueprint?.name ?? "Automation");

  const refresh = useCallback(async () => {
    try {
      const [bp, trg, terms, hostList] = await Promise.all([
        api.getLocalBlueprint(id),
        api.listLocalBlueprintTriggers(id).catch(() => ({ triggers: [] })),
        api.listLocalTerminals().catch(() => ({ terminals: [] })),
        api.listLocalHosts().catch(() => ({ hosts: [] })),
      ]);
      setBlueprint(bp.blueprint);
      setTriggers(trg.triggers);
      setRuns(terms.terminals.filter((t: any) => t.blueprintId === id));
      setHosts(hostList.hosts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the automation");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 5_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const host = hosts.find((h) => h.id === blueprint?.hostId);
  const active = runs.filter((r) => r.state === "running" || r.state === "launching");
  const needsYou = runs.filter((r) => r.state === "running" && r.attentionState === "needs_you");
  const lastRun = runs[0] ?? null;
  const totalCost = useMemo(
    () => runs.reduce((sum, r) => sum + (parseFloat(r.costUsd ?? "") || 0), 0),
    [runs],
  );
  const nextFire = triggers
    .filter((t) => t.enabled !== false && t.nextFireAt)
    .map((t) => t.nextFireAt as string)
    .sort()[0];

  const runNow = async () => {
    setBusy(true);
    try {
      const res = await api.spawnLocalBlueprint(id);
      toast.success("Automation started", {
        action: { label: "Open", onClick: () => router.push(`/local/${res.terminal.id}`) },
      });
      await refresh();
    } catch (err) {
      toast.error("Couldn't start it", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      const res = await api.updateLocalBlueprint(id, { enabled: !blueprint.enabled });
      setBlueprint(res.blueprint);
    } catch (err) {
      toast.error("Update failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${blueprint.name}"? Its triggers go with it; past runs stay.`)) return;
    setBusy(true);
    try {
      await api.deleteLocalBlueprint(id);
      toast.success("Automation deleted");
      router.push("/work?view=recurring");
    } catch (err) {
      toast.error("Delete failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading automation...
      </div>
    );
  }

  if (error || !blueprint) {
    return (
      <div className="page-column py-6">
        <Link
          href="/work?view=recurring"
          className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text mb-4"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Work
        </Link>
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <XCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>{error ?? "Automation not found"}</p>
        </div>
      </div>
    );
  }

  const where = [host?.name, shortDir(blueprint.dir)].filter(Boolean).join(" · ");

  return (
    <>
      <DetailHeader
        title={blueprint.name}
        subtitle={
          <Link
            href="/work?view=recurring"
            className="inline-flex items-center gap-1 hover:text-primary"
          >
            <ArrowLeft className="w-3 h-3" />
            Work
          </Link>
        }
        state={blueprint.enabled ? "enabled" : "disabled"}
        metaItems={[
          <span key="who" className="inline-flex items-center gap-1">
            {blueprint.agent ? <Bot className="w-3 h-3" /> : <Terminal className="w-3 h-3" />}
            {blueprint.agent ? (AGENT_LABELS[blueprint.agent] ?? blueprint.agent) : "shell"}
          </span>,
          <span key="where" className="inline-flex items-center gap-1 font-mono">
            <Laptop className="w-3 h-3" />
            {where || "any machine"}
          </span>,
          ...(blueprint.baseBranch
            ? [<span key="branch">new branch off {blueprint.baseBranch} → PR</span>]
            : []),
          ...(blueprint.description
            ? [
                <span key="desc" className="text-text-muted">
                  {blueprint.description}
                </span>,
              ]
            : []),
        ]}
        rightSlot={
          <button
            onClick={() => refresh()}
            disabled={busy}
            className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        }
        actions={
          <>
            <Button size="sm" onClick={runNow} disabled={busy} title="Start one session now">
              <Play /> Run
            </Button>
            <ButtonLink variant="secondary" size="sm" href={`/work/${id}/edit`}>
              <Pencil /> Edit
            </ButtonLink>
            <button
              onClick={toggle}
              disabled={busy}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors",
                blueprint.enabled
                  ? "bg-warning/10 text-warning hover:bg-warning/20"
                  : "bg-success/10 text-success hover:bg-success/20",
              )}
            >
              {blueprint.enabled ? (
                <>
                  <Pause className="w-3 h-3" /> Pause
                </>
              ) : (
                <>
                  <Play className="w-3 h-3" /> Resume
                </>
              )}
            </button>
            <Button variant="danger" size="sm" onClick={remove} disabled={busy}>
              <Trash2 /> Delete
            </Button>
          </>
        }
      />

      <div className="page-column py-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <MetadataCard icon={Hash} label="Runs" value={runs.length} size="lg" />
          <MetadataCard
            icon={Activity}
            label="Needs you"
            value={needsYou.length > 0 ? needsYou.length : "—"}
            size="lg"
          />
          <MetadataCard
            icon={DollarSign}
            label="Total cost"
            value={totalCost > 0 ? `$${totalCost.toFixed(2)}` : "—"}
            size="lg"
          />
          <MetadataCard
            icon={Clock}
            label={nextFire ? "Next run" : "Last run"}
            value={
              nextFire
                ? formatRelativeTime(nextFire)
                : lastRun
                  ? formatRelativeTime(lastRun.createdAt)
                  : "—"
            }
            size="lg"
          />
        </div>

        {active.length > 0 && (
          <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-sm text-primary">
            <Loader2 className="w-4 h-4 animate-spin" />
            {active.length} session{active.length !== 1 ? "s" : ""} open — auto-refreshing
          </div>
        )}

        <div className="space-y-6">
          <Panel
            title="Triggers"
            actions={
              <Link href={`/work/${id}/edit`} className="text-primary hover:underline">
                Edit
              </Link>
            }
          >
            {triggers.length === 0 ? (
              <PanelEmpty>
                Starts by hand only.{" "}
                <Link href={`/work/${id}/edit`} className="text-primary hover:underline">
                  Add a trigger
                </Link>
                .
              </PanelEmpty>
            ) : (
              <div className="divide-y divide-border/60">
                {triggers.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-3 px-4 py-2.5 bg-bg-card/40 text-sm"
                  >
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full shrink-0",
                        t.enabled === false ? "bg-text-muted/40" : "bg-success",
                      )}
                      aria-label={t.enabled === false ? "paused" : "armed"}
                    />
                    <TriggerIcon
                      type={t.type}
                      source={t.config?.source}
                      className="text-text-muted"
                    />
                    <span className="capitalize font-medium text-text-heading">{t.type}</span>
                    <span className="font-mono text-xs text-text-muted truncate flex-1">
                      {triggerSummary(t)}
                    </span>
                    {t.type === "schedule" && t.nextFireAt && (
                      <span className="text-[11px] text-text-muted whitespace-nowrap">
                        next {formatRelativeTime(t.nextFireAt)}
                      </span>
                    )}
                    {t.lastFiredAt && (
                      <span className="text-[11px] text-text-muted whitespace-nowrap">
                        fired {formatRelativeTime(t.lastFiredAt)}
                      </span>
                    )}
                    <span className="text-[11px] text-text-muted/70 whitespace-nowrap">
                      {t.enabled === false ? "paused" : "armed"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {runs.length === 0 ? (
            <EmptyState
              icon={Terminal}
              title="Nothing has run yet"
              description="Each session this automation starts shows up here."
              action={
                <Button onClick={runNow} disabled={busy}>
                  <Play /> Run it now
                </Button>
              }
            />
          ) : (
            <Panel
              title="Runs"
              actions={<span className="text-text-muted tabular-nums">{runs.length}</span>}
            >
              <div className="divide-y divide-border/60">
                {runs.map((r) => {
                  const st = runState(r);
                  return (
                    <Link
                      key={r.id}
                      href={`/local/${r.id}`}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3 bg-bg-card/40 hover:bg-bg-hover/60 transition-colors"
                    >
                      <span className={cn("w-2 h-2 rounded-full", st.dot)} aria-label={st.label} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text-heading truncate">
                          {r.title ?? "Session"}
                        </div>
                        <div className="text-[11px] text-text-muted truncate">
                          <span className={st.tone}>{st.label}</span>
                          {r.attentionState === "needs_you" && r.attentionReason && (
                            <span className="text-text-muted/70"> · {r.attentionReason}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-text-muted whitespace-nowrap">
                        {r.costUsd && parseFloat(r.costUsd) > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <DollarSign className="w-3 h-3 text-text-muted/60" />
                            {parseFloat(r.costUsd).toFixed(2)}
                          </span>
                        )}
                        {r.startedAt && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3 text-text-muted/60" />
                            {formatDuration(r.startedAt, r.endedAt ?? undefined)}
                          </span>
                        )}
                        <span className="text-text-muted/70">
                          {formatRelativeTime(r.createdAt)}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
