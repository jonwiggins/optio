"use client";

import { useCallback, useEffect, useState } from "react";
import { PauseCircle } from "lucide-react";
import { api, type AgentWorkPause } from "@/lib/api-client";

/** Fired after the settings card pauses, resumes or stops, so the banner follows at once. */
export const AGENT_WORK_CHANGED_EVENT = "optio:agent-work-changed";

const POLL_MS = 30_000;

/**
 * Shown to everyone on every page while a deployment admin has paused all
 * agent work (Settings → Access → Agent work; docs/pausing-agent-work.md).
 * Nothing shows otherwise.
 */
export function AgentWorkPausedBanner() {
  const [pause, setPause] = useState<AgentWorkPause | null>(null);

  const check = useCallback(async () => {
    try {
      setPause(await api.getAgentWorkPause());
    } catch {
      // Unreachable or signed out: show nothing rather than a stale state.
    }
  }, []);

  useEffect(() => {
    void check();
    const interval = setInterval(() => void check(), POLL_MS);
    const onChanged = () => void check();
    window.addEventListener(AGENT_WORK_CHANGED_EVENT, onChanged);
    return () => {
      clearInterval(interval);
      window.removeEventListener(AGENT_WORK_CHANGED_EVENT, onChanged);
    };
  }, [check]);

  if (!pause?.paused) return null;

  return (
    <div
      role="status"
      className="shrink-0 bg-warning/10 border-b border-warning/30 px-4 py-2 flex items-center gap-2 text-sm"
    >
      <PauseCircle className="w-4 h-4 text-warning shrink-0" />
      <span className="text-text-heading font-medium">
        Agent work is paused by an administrator
        {pause.reason ? `: ${pause.reason}` : ""}
      </span>
      <span className="text-text-muted">
        New work is held or refused until it is resumed.
        {pause.canEdit && (
          <>
            {" "}
            <a href="/settings#access" className="underline hover:text-text transition-colors">
              Resume in Settings → Access
            </a>
          </>
        )}
      </span>
    </div>
  );
}
