"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type AgentWorkPause, type AgentWorkStopCounts } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Button } from "@/components/ui/button";
import { AGENT_WORK_CHANGED_EVENT } from "@/components/layout/agent-work-paused-banner";

/**
 * Settings → Access → Agent work: pause all agent work, or stop everything,
 * for an incident or an upgrade (docs/pausing-agent-work.md). Shown to
 * deployment admins only; the API refuses anyone else. Both ask for a reason,
 * which everyone sees in the banner and the action log keeps.
 */

type Confirming = "pause" | "stop" | null;

function stoppedSummary(c: AgentWorkStopCounts): string {
  const parts = [
    [c.tasks, "task"],
    [c.jobRuns, "job run"],
    [c.reviews, "review"],
    [c.agents, "agent"],
    [c.sessions, "session"],
    [c.terminals, "Local terminal"],
  ] as const;
  const named = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
  return named.length ? `Cancelled ${named.join(", ")}` : "Nothing was running";
}

export function AgentWorkSettings() {
  const [pause, setPause] = useState<AgentWorkPause | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getAgentWorkPause()
      .then(setPause)
      .catch(() => {});
  }, []);

  if (!pause?.canEdit) return null;

  const changed = (next: AgentWorkPause) => {
    setPause(next);
    setConfirming(null);
    setReason("");
    window.dispatchEvent(new Event(AGENT_WORK_CHANGED_EVENT));
  };

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const confirm = () =>
    run(async () => {
      const why = reason.trim();
      if (confirming === "stop") {
        const result = await api.stopAllAgentWork(why);
        changed(result);
        toast.success("All agent work stopped", { description: stoppedSummary(result.cancelled) });
      } else {
        changed(await api.setAgentWorkPause({ paused: true, reason: why }));
        toast.success("Agent work paused");
      }
    });

  const resume = () =>
    run(async () => {
      changed(await api.setAgentWorkPause({ paused: false }));
      toast.success("Agent work resumed");
    });

  const since = pause.pausedAt ? new Date(pause.pausedAt).toLocaleString() : null;

  return (
    <SectionCard
      label="Agent work"
      hint="Pause or stop every agent in the deployment"
      summary={pause.paused ? "Paused" : "Running"}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        Pause: no new agent work starts in any workspace. Queued, scheduled and triggered work is
        held and starts when you resume; people starting work are told why. Work already running
        carries on. Stop everything: pause, and cancel every queued and running task, job run,
        review, agent turn, session and Local agent terminal in every workspace.
      </p>

      {pause.paused ? (
        <div className="space-y-3" data-testid="agent-work-paused">
          <p className="text-sm text-text-heading">
            Paused{pause.pausedBy?.name ? ` by ${pause.pausedBy.name}` : ""}
            {since ? ` since ${since}` : ""}: {pause.reason}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void resume()} disabled={busy}>
              Resume agent work
            </Button>
            {confirming === null && (
              <Button size="sm" variant="danger" onClick={() => setConfirming("stop")}>
                Stop everything…
              </Button>
            )}
          </div>
        </div>
      ) : (
        confirming === null && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirming("pause")}>
              Pause agent work…
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirming("stop")}>
              Stop everything…
            </Button>
          </div>
        )
      )}

      {confirming && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <label
            className="block text-xs font-medium text-text-heading"
            htmlFor="agent-work-reason"
          >
            {confirming === "stop"
              ? "Why stop everything? Everyone sees this."
              : "Why pause? Everyone sees this."}
          </label>
          <textarea
            id="agent-work-reason"
            className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {confirming === "stop" && (
            <p className="text-xs text-error">
              This cancels all queued and running agent work in every workspace. It can&apos;t be
              undone; cancelled work has to be started again.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={confirming === "stop" ? "danger" : "primary"}
              disabled={busy || !reason.trim()}
              onClick={() => void confirm()}
            >
              {confirming === "stop" ? "Stop everything" : "Pause agent work"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setConfirming(null);
                setReason("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
