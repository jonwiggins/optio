"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  ALERTMANAGER_EVENT_KINDS,
  DATADOG_EVENT_KINDS,
  GITHUB_EVENT_KINDS,
  GITLAB_EVENT_KINDS,
  JIRA_EVENT_KINDS,
  LINEAR_EVENT_KINDS,
  PAGERDUTY_EVENT_KINDS,
  SENTRY_EVENT_KINDS,
  isSelfSecretTriggerType,
} from "@optio/shared";
import {
  CopyButton,
  SECRET_COPY,
  SECRET_HEADER,
  TriggerSecretDialog,
  hookUrl,
  newTriggerSecret,
} from "./pylon-secret-dialog";

/** One kind an event trigger can listen for, as people read it; `personal` kinds need an identity. */
export interface EventKind {
  value: string;
  label: string;
  personal: boolean;
}

const kinds = (
  values: readonly string[],
  labels: Record<string, string>,
  personal: readonly string[] = [],
): EventKind[] =>
  values.map((value) => ({
    value,
    label: labels[value] ?? value.replace(/[._]/g, " "),
    personal: personal.includes(value),
  }));

export const GITHUB_KIND_LABELS: Record<string, string> = {
  review_requested: "Review requested from me",
  mentioned: "I'm @-mentioned",
  assigned: "Assigned to me",
  pr_opened: "Any PR opened",
  issue_opened: "Any issue opened",
  pr_merged: "A PR is merged",
  labeled: "A label is added",
  push: "A branch is pushed",
  release_published: "A release is published",
  workflow_succeeded: "A workflow run passes",
  workflow_failed: "A workflow run fails",
};

export const GITLAB_KIND_LABELS: Record<string, string> = {
  review_requested: "Review requested from me",
  mentioned: "I'm @-mentioned",
  assigned: "Assigned to me",
  mr_opened: "Any MR opened",
  mr_merged: "An MR is merged",
  issue_opened: "Any issue opened",
  labeled: "A label is added",
  push: "A branch is pushed",
  release_published: "A release is published",
  pipeline_succeeded: "A pipeline passes",
  pipeline_failed: "A pipeline fails",
};

export const LINEAR_KIND_LABELS: Record<string, string> = {
  assigned: "Assigned to me",
  mentioned: "I'm @-mentioned",
  created: "Any issue created",
  labeled: "A label is added",
};

export const JIRA_KIND_LABELS: Record<string, string> = {
  assigned: "Assigned to me",
  mentioned: "I'm mentioned",
  created: "Any issue created",
  commented: "A comment is added",
  transitioned: "Status changes",
  labeled: "A label is added",
};

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

export const SENTRY_KIND_LABELS: Record<string, string> = {
  issue_created: "New issue",
  issue_unresolved: "Issue regressed",
  issue_resolved: "Issue resolved",
  issue_assigned: "Issue assigned",
  issue_archived: "Issue archived",
  alert_triggered: "Issue alert fires",
  metric_alert_critical: "Metric alert critical",
  metric_alert_warning: "Metric alert warning",
  metric_alert_resolved: "Metric alert resolved",
};

export const ALERTMANAGER_KIND_LABELS: Record<string, string> = {
  firing: "Alerts firing",
  resolved: "Alerts resolved",
};

export const DATADOG_KIND_LABELS: Record<string, string> = {
  triggered: "Monitor triggered",
  warning: "Monitor warning",
  no_data: "No data",
  recovered: "Monitor recovered",
};

const PERSONAL = ["review_requested", "mentioned", "assigned"] as const;

export const GITHUB_KINDS: EventKind[] = kinds(GITHUB_EVENT_KINDS, GITHUB_KIND_LABELS, PERSONAL);
export const GITLAB_KINDS: EventKind[] = kinds(GITLAB_EVENT_KINDS, GITLAB_KIND_LABELS, PERSONAL);
export const LINEAR_KINDS: EventKind[] = kinds(LINEAR_EVENT_KINDS, LINEAR_KIND_LABELS, [
  "assigned",
  "mentioned",
]);
export const JIRA_KINDS: EventKind[] = kinds(JIRA_EVENT_KINDS, JIRA_KIND_LABELS, [
  "assigned",
  "mentioned",
]);
export const PAGERDUTY_KINDS: EventKind[] = kinds(PAGERDUTY_EVENT_KINDS, PAGERDUTY_KIND_LABELS);
export const SENTRY_KINDS: EventKind[] = kinds(SENTRY_EVENT_KINDS, SENTRY_KIND_LABELS);
export const ALERTMANAGER_KINDS: EventKind[] = kinds(
  ALERTMANAGER_EVENT_KINDS,
  ALERTMANAGER_KIND_LABELS,
);
export const DATADOG_KINDS: EventKind[] = kinds(DATADOG_EVENT_KINDS, DATADOG_KIND_LABELS);

/**
 * The kinds each event trigger offers as a checklist. Slack listens to
 * messages (no kinds) and Pylon's kinds are free text, so both are empty.
 */
export const EVENT_KINDS: Record<string, EventKind[]> = {
  github: GITHUB_KINDS,
  gitlab: GITLAB_KINDS,
  slack: [],
  linear: LINEAR_KINDS,
  jira: JIRA_KINDS,
  pylon: [],
  pagerduty: PAGERDUTY_KINDS,
  sentry: SENTRY_KINDS,
  alertmanager: ALERTMANAGER_KINDS,
  datadog: DATADOG_KINDS,
};

/** The config key naming whom personal kinds are about, per type; null when none is. */
export const IDENTITY_KEY: Record<string, string | null> = {
  github: "login",
  gitlab: "username",
  slack: null,
  linear: "user",
  jira: "user",
  pylon: null,
  pagerduty: null,
  sentry: null,
  alertmanager: null,
  datadog: null,
};

/** A kind as people read it, falling back to its value with the punctuation spaced. */
export function eventKindLabel(type: string, kind: string): string {
  const hit = EVENT_KINDS[type]?.find((k) => k.value === kind);
  if (hit) return hit.label;
  return type === "pagerduty"
    ? kind.replace(/^incident\./, "").replace(/[._]/g, " ")
    : kind.replace(/[._]/g, " ");
}

export const pagerDutyKindLabel = (kind: string): string => eventKindLabel("pagerduty", kind);

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];

/**
 * One line about an event trigger's filters — what it listens for, never
 * the raw config. A self-secret trigger's secret is never in the config a
 * read returns, and its URL is rendered by `EventTriggerDetails`, not here.
 */
export function eventTriggerSummary(type: string, config: Record<string, unknown> | null): string {
  const c = config ?? {};
  const events = list(c.events);
  const named = (what: string) =>
    events.length ? events.map((k) => eventKindLabel(type, k)).join(", ") : what;
  const where = (key: string, word: string) => {
    const xs = list(c[key]);
    return xs.length ? ` ${word} ${xs.join(", ")}` : "";
  };
  switch (type) {
    case "github": {
      const repos = list(c.repos);
      return `${events.length ? events.join(", ") : "any event"}${
        c.login ? ` → @${String(c.login)}` : ""
      }${repos.length ? ` in ${repos.join(", ")}` : ""}${where("branches", "on")}${where(
        "labels",
        "·",
      )}`;
    }
    case "gitlab": {
      const projects = list(c.projects);
      return `${events.length ? events.join(", ") : "any event"}${
        c.username ? ` → @${String(c.username)}` : ""
      }${projects.length ? ` in ${projects.join(", ")}` : ""}${where("branches", "on")}${where(
        "labels",
        "·",
      )}`;
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
    case "jira": {
      const projects = list(c.projects);
      return `${events.length ? events.join(", ") : "any event"}${
        c.user ? ` → ${String(c.user)}` : ""
      }${projects.length ? ` in ${projects.join(", ")}` : ""}${where("labels", "·")}${where(
        "issueTypes",
        "·",
      )}${where("statuses", "→")}`;
    }
    case "pagerduty": {
      const services = list(c.services);
      return `${named("any incident event")}${services.length ? ` on ${services.join(", ")}` : ""}${
        c.urgency === "high" || c.urgency === "low" ? ` · ${String(c.urgency)} urgency` : ""
      }`;
    }
    case "pylon":
      return events.length ? events.join(", ") : "any event";
    case "sentry":
      return `${named("any Sentry event")}${where("projects", "in")}${where(
        "environments",
        "on",
      )}${where("levels", "·")}`;
    case "alertmanager":
      return `${named("firing or resolved")}${where("alertnames", "·")}${where(
        "severities",
        "·",
      )}${where("receivers", "via")}`;
    case "datadog":
      return `${named("any transition")}${where("priorities", "·")}${where("tags", "·")}${where(
        "monitors",
        "on",
      )}`;
    default:
      return "";
  }
}

/**
 * An event trigger on a work's page: its summary line, and for a self-secret
 * trigger (Pylon, Alertmanager, Datadog) the URL it listens on, the header
 * name, whether a secret is set, and a Regenerate button that mints a new
 * secret client-side, PATCHes it, and shows it once. Test ids are
 * `<type>-trigger-details` and `<type>-secret-state`.
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
  const type = trigger.type;

  if (!isSelfSecretTriggerType(type)) {
    return summary ? (
      <p className="text-xs text-text-muted mt-0.5 truncate" title={summary}>
        {summary}
      </p>
    ) : null;
  }

  const url = hookUrl(type, trigger.id);
  const regenerate = async () => {
    if (!updateConfig) return;
    if (
      c.hasSecret &&
      !confirm(
        `Regenerate the secret? ${SECRET_COPY[type].title.replace(" is listening", "")} deliveries with the old one will be rejected.`,
      )
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
    <div className="mt-1 space-y-1" data-testid={`${type}-trigger-details`}>
      <p className="text-xs text-text-muted truncate">Events: {summary}</p>
      <div className="flex items-center gap-1.5 min-w-0">
        <code className="text-xs text-text-muted bg-bg rounded px-1.5 py-0.5 font-mono truncate">
          {url}
        </code>
        <CopyButton
          value={url}
          label={`${SECRET_COPY[type].title.replace(" is listening", "")} URL`}
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-text-muted flex-wrap">
        <span>
          Header <code className="font-mono">{SECRET_HEADER}</code>
        </span>
        <span>·</span>
        <span data-testid={`${type}-secret-state`}>{c.hasSecret ? "Secret set" : "No secret"}</span>
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
        <TriggerSecretDialog
          type={type}
          triggerId={trigger.id}
          secret={minted}
          onDone={() => setMinted(null)}
        />
      )}
    </div>
  );
}
