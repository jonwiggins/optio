/**
 * A Work manifest's `when` ⇄ the trigger the API stores. Pure: the manifest
 * says `schedule: "<cron>"`, `webhook: { path }`, `ticket: { source, labels }`
 * or passes an event trigger's config through under its type (`github`,
 * `gitlab`, `slack`, `linear`, `jira`, `pylon`, `pagerduty`, `sentry`,
 * `alertmanager`, `datadog`); the row says `{ type, config }`. A webhook's or
 * a self-secret trigger's shared secret lives only on the row.
 */
import { EVENT_TRIGGER_TYPES, type WorkWhen, type WorkWhenManifest } from "@optio/shared";

/** The manifest's `when` as the trigger `POST /api/work` takes. */
export function whenFromManifest(when: WorkWhenManifest | undefined): WorkWhen {
  if (!when) return { type: "manual" };
  if ("schedule" in when) {
    const cron = typeof when.schedule === "string" ? when.schedule : when.schedule.cron;
    return { type: "schedule", config: { cronExpression: cron } };
  }
  if ("webhook" in when) return { type: "webhook", config: { path: when.webhook.path } };
  if ("ticket" in when) {
    return {
      type: "ticket",
      config: {
        source: when.ticket.source,
        ...(when.ticket.labels?.length ? { labels: when.ticket.labels } : {}),
      },
    };
  }
  const events = when as Partial<Record<(typeof EVENT_TRIGGER_TYPES)[number], unknown>>;
  for (const type of EVENT_TRIGGER_TYPES) {
    const config = events[type];
    if (config && typeof config === "object") {
      return { type, config: config as Record<string, unknown> };
    }
  }
  return { type: "manual" };
}

/** A stored trigger as a manifest's `when` (a webhook's / self-secret trigger's secret never leaves the row). */
export function whenToManifest(
  trigger: { type: string; config: unknown } | null,
): WorkWhenManifest | undefined {
  if (!trigger) return undefined;
  const config = { ...((trigger.config ?? {}) as Record<string, unknown>) };
  switch (trigger.type) {
    case "schedule":
      return { schedule: String(config.cronExpression ?? "") };
    case "webhook":
      return { webhook: { path: String(config.path ?? "") } };
    case "ticket":
      return {
        ticket: {
          source: String(config.source ?? ""),
          ...(Array.isArray(config.labels) && config.labels.length
            ? { labels: config.labels as string[] }
            : {}),
        },
      };
    default: {
      if (!(EVENT_TRIGGER_TYPES as readonly string[]).includes(trigger.type)) return undefined;
      const { secret: _secret, hasSecret: _hasSecret, ...rest } = config;
      return { [trigger.type]: rest } as WorkWhenManifest;
    }
  }
}
