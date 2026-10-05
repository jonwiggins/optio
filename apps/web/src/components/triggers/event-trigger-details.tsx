"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  CopyButton,
  PYLON_SECRET_HEADER,
  PylonSecretDialog,
  newTriggerSecret,
  pylonHookUrl,
} from "./pylon-secret-dialog";

/** PagerDuty's `incident.*` kinds, as people read them. */
export const PAGERDUTY_KIND_LABELS: Record<string, string> = {
  "incident.triggered": "Triggered",
  "incident.acknowledged": "Acknowledged",
  "incident.unacknowledged": "Unacknowledged",
  "incident.resolved": "Resolved",
  "incident.escalated": "Escalated",
  "incident.reassigned": "Reassigned",
  "incident.delegated": "Delegated",
  "incident.reopened": "Reopened",
  "incident.priority_updated": "Priority updated",
  "incident.responder.added": "Responder added",
  "incident.responder.replied": "Responder replied",
  "incident.status_update_published": "Status update published",
  "incident.annotated": "Annotated",
};

export const pagerDutyKindLabel = (kind: string): string =>
  PAGERDUTY_KIND_LABELS[kind] ?? kind.replace(/^incident\./, "").replace(/[._]/g, " ");

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];

/**
 * One line about an event trigger's filters — what it listens for, never
 * the raw config. Pylon's secret is never in the config a read returns, and
 * its URL is rendered by `EventTriggerDetails`, not here.
 */
export function eventTriggerSummary(type: string, config: Record<string, unknown> | null): string {
  const c = config ?? {};
  const events = list(c.events);
  switch (type) {
    case "github": {
      const repos = list(c.repos);
      return `${events.length ? events.join(", ") : "any event"}${
        c.login ? ` → @${String(c.login)}` : ""
      }${repos.length ? ` in ${repos.join(", ")}` : ""}`;
    }
    case "slack": {
      const by =
        c.postedBy === "bots" || c.postedBy === "anyone"
          ? ` · ${c.bot ? String(c.bot) : c.postedBy === "bots" ? "bots" : "people + bots"}`
          : "";
      return `${c.channelId ?? "?"}${c.mentionOnly ? " (@-mentions)" : ""}${by}${
        c.keyword ? ` · "${String(c.keyword)}"` : ""
      }`;
    }
    case "linear": {
      const teams = list(c.teams);
      const labels = list(c.labels);
      return `${events.length ? events.join(", ") : "any event"}${
        c.user ? ` → ${String(c.user)}` : ""
      }${teams.length ? ` in ${teams.join(", ")}` : ""}${
        labels.length ? ` · ${labels.join(", ")}` : ""
      }${c.othersOnly ? " · from others" : ""}`;
    }
    case "pagerduty": {
      const services = list(c.services);
      const kinds = events.length
        ? events.map(pagerDutyKindLabel).join(", ")
        : "any incident event";
      return `${kinds}${services.length ? ` on ${services.join(", ")}` : ""}${
        c.urgency === "high" || c.urgency === "low" ? ` · ${String(c.urgency)} urgency` : ""
      }`;
    }
    case "pylon":
      return events.length ? events.join(", ") : "any event";
    default:
      return "";
  }
}

/**
 * An event trigger on a work's page: its summary line, and for Pylon the URL
 * it listens on, the header name, whether a secret is set, and a Regenerate
 * button that mints a new secret client-side, PATCHes it, and shows it once.
 */
export function EventTriggerDetails({
  trigger,
  updateConfig,
}: {
  trigger: { id: string; type: string; config: Record<string, unknown> | null };
  /** PATCH the trigger's config; absent = read-only (no Regenerate). */
  updateConfig?: (config: Record<string, unknown>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const summary = eventTriggerSummary(trigger.type, trigger.config);
  const c = trigger.config ?? {};

  if (trigger.type !== "pylon") {
    return summary ? (
      <p className="text-xs text-text-muted mt-0.5 truncate" title={summary}>
        {summary}
      </p>
    ) : null;
  }

  const url = pylonHookUrl(trigger.id);
  const regenerate = async () => {
    if (!updateConfig) return;
    if (
      c.hasSecret &&
      !confirm("Regenerate the secret? Pylon deliveries with the old one will be rejected.")
    )
      return;
    const secret = newTriggerSecret();
    setBusy(true);
    try {
      const { hasSecret: _h, secret: _s, ...rest } = c;
      await updateConfig({ ...rest, secret });
      setMinted(secret);
    } catch (err) {
      toast.error("Couldn't regenerate the secret", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 space-y-1" data-testid="pylon-trigger-details">
      <p className="text-xs text-text-muted truncate">Events: {summary}</p>
      <div className="flex items-center gap-1.5 min-w-0">
        <code className="text-xs text-text-muted bg-bg rounded px-1.5 py-0.5 font-mono truncate">
          {url}
        </code>
        <CopyButton value={url} label="Pylon URL" />
      </div>
      <div className="flex items-center gap-2 text-xs text-text-muted flex-wrap">
        <span>
          Header <code className="font-mono">{PYLON_SECRET_HEADER}</code>
        </span>
        <span>·</span>
        <span data-testid="pylon-secret-state">{c.hasSecret ? "Secret set" : "No secret"}</span>
        {updateConfig && (
          <button
            type="button"
            onClick={regenerate}
            disabled={busy}
            className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            {c.hasSecret ? "Regenerate" : "Set a secret"}
          </button>
        )}
      </div>
      {minted && (
        <PylonSecretDialog triggerId={trigger.id} secret={minted} onDone={() => setMinted(null)} />
      )}
    </div>
  );
}
