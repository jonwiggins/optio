/**
 * Credential health (docs/credential-health.md): the warnings a check sends
 * through `notify()` — a token about to expire (30, 7 and 1 days ahead), one
 * a service refuses, a gateway token over its budget — each at most once per
 * threshold per credential.
 *
 * What was sent is kept on the row (`credential_checks.notified`, marker →
 * time): `expiry:<days>:<date>` (a renewed token has another date, so its
 * own warnings go out again), `invalid`, `budget:<reset>`. A credential that
 * works again drops `invalid` and its `budget:` markers, so the next failure
 * is news. An `unknown` check (the service unreachable) changes nothing.
 *
 * Who hears: a person's credential, that person; the organization's, the
 * admins of its workspace (a gateway's tokens, a GitLab token stored for a
 * workspace), or the deployment admins for a deployment-wide one.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { workspaceMembers } from "../../db/schema.js";
import { NO_ADDRESS, notify, type NotifyResult } from "../notify.js";
import { listDeploymentAdmins } from "../sign-in-config-service.js";
import type { CredentialRef } from "./inventory.js";
import {
  type CheckOutcome,
  daysLeft,
  EXPIRY_THRESHOLDS,
  formatUtc,
  inDays,
  spentOf,
} from "./outcome.js";

export type AlertKind = "token.expiring" | "token.invalid" | "budget.exceeded";

export interface Alert {
  kind: AlertKind;
  /** The markers to record once it went out. */
  markers: string[];
  /** For `token.expiring`: the threshold crossed (30, 7, 1). */
  threshold?: number;
}

const dateOf = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The warnings `outcome` calls for, given what was already sent, and the
 * markers to keep whatever is sent now. Pure: the caller sends, then adds
 * each sent alert's markers.
 */
export function dueAlerts(
  notified: Record<string, string>,
  outcome: CheckOutcome,
  now: Date,
): { alerts: Alert[]; keep: Record<string, string> } {
  const keep: Record<string, string> = { ...notified };
  const alerts: Alert[] = [];
  if (outcome.status === "unknown") return { alerts, keep };

  if (outcome.invalid) {
    if (!keep.invalid) alerts.push({ kind: "token.invalid", markers: ["invalid"] });
  } else {
    delete keep.invalid;
  }

  if (outcome.overBudget) {
    const o = outcome.overBudget;
    const marker = `budget:${o.resetAt ?? (o.resetUnknown ? "unknown" : "none")}`;
    for (const k of Object.keys(keep)) if (k.startsWith("budget:") && k !== marker) delete keep[k];
    if (!keep[marker]) alerts.push({ kind: "budget.exceeded", markers: [marker] });
  } else {
    for (const k of Object.keys(keep)) if (k.startsWith("budget:")) delete keep[k];
  }

  const date = outcome.expiresAt ? dateOf(outcome.expiresAt) : null;
  // Another expiry date (a renewed token, or none at all): its warnings are new.
  for (const k of Object.keys(keep)) {
    if (k.startsWith("expiry:") && (!date || !k.endsWith(`:${date}`))) delete keep[k];
  }
  if (outcome.expiresAt && !outcome.invalid) {
    const days = daysLeft(outcome.expiresAt, now);
    const crossed = EXPIRY_THRESHOLDS.filter((t) => days <= t);
    const threshold = crossed.length ? Math.min(...crossed) : null;
    if (threshold !== null && !keep[`expiry:${threshold}:${date}`]) {
      // The nearest threshold only; the farther ones count as sent (a token
      // first seen 5 days out gets the 7-day warning, never the 30-day one).
      alerts.push({
        kind: "token.expiring",
        threshold,
        markers: crossed.map((t) => `expiry:${t}:${date}`),
      });
    }
  }
  return { alerts, keep };
}

const WHAT: Record<CredentialRef["kind"], string> = {
  gitlab: "GitLab token",
  gateway: "gateway token",
};

/** "Your", "The organization's". */
function whose(ref: CredentialRef): string {
  return ref.scope === "person" ? "Your" : "The organization's";
}

/** What stops when the credential does. */
function consequence(ref: CredentialRef): string {
  const work = ref.scope === "person" ? "your work" : "the organization's work";
  switch (ref.kind) {
    case "gitlab":
      return ref.scope === "organization"
        ? "Optio uses it for the webhooks, merge requests and merges of all work that has no personal GitLab token: those stop with it."
        : `Optio and the agents use it for ${work} on GitLab: clones, merge requests and merges stop with it.`;
    case "gateway":
      return `Every run of ${work} signs in to the model gateway with it: runs fail before they start until it is fixed.`;
  }
}

export interface Notice {
  subject: string;
  body: string;
}

/** The email for one alert. */
export function noticeFor(
  ref: CredentialRef,
  outcome: CheckOutcome,
  alert: Alert,
  now: Date,
): Notice {
  const who = whose(ref);
  const what = WHAT[ref.kind];
  const label = ref.label.includes("·") ? ` (${ref.label.split("·")[1].trim()})` : "";
  let subject: string;
  let lead: string;
  if (alert.kind === "token.expiring" && outcome.expiresAt) {
    const days = daysLeft(outcome.expiresAt, now);
    subject = `${who} ${what} expires ${inDays(days)}`;
    lead = `${who} ${what}${label} expires ${inDays(days)}, on ${formatUtc(outcome.expiresAt)}.`;
  } else if (alert.kind === "budget.exceeded" && outcome.overBudget) {
    const o = outcome.overBudget;
    subject = `${who} ${what} is over budget`;
    lead =
      `${who} ${what}${label} is over its budget: ${spentOf(o)}. ` +
      (o.resetAt
        ? `The gateway resets it on ${formatUtc(o.resetAt)}.`
        : o.resetUnknown
          ? "The gateway refuses it and doesn't say when it resets: ask its admin, or replace the token."
          : "It doesn't reset by itself: the gateway's admin raises it, or the token is replaced.");
  } else {
    subject = `${who} ${what} stopped working`;
    lead = `${who} ${what}${label} was refused: ${outcome.reason ?? "the service turned it away"}.`;
  }
  const body = [
    lead,
    consequence(ref),
    `Fix it under ${ref.fixAt}.`,
    "Settings → My tokens shows each token you look after, with Check now.",
  ].join("\n\n");
  return { subject, body };
}

/**
 * Whether a send counts as done: someone got it, chose not to, or there was
 * no one to tell. People with no address (NO_ADDRESS) count as no one.
 * Anything else (email isn't set up, the relay is down) keeps it due, so it
 * goes out once email works.
 */
export function delivered(result: NotifyResult): boolean {
  if (result.sent.length > 0) return true;
  if (result.skipped.some((s) => s.why === "turned off")) return true;
  if (result.skipped.length > 0 && result.skipped.every((s) => s.why === NO_ADDRESS)) return true;
  return result.error === "No one to send it to";
}

/** One alert's sends, as one result (sent to anyone, or why no one got it). */
export function mergeResults(results: NotifyResult[]): NotifyResult {
  const merged: NotifyResult = {
    sent: results.flatMap((r) => r.sent),
    skipped: results.flatMap((r) => r.skipped),
  };
  const errors = results.map((r) => r.error).filter((e): e is string => !!e);
  // Every send failed for its own reason: say the first that isn't "no one".
  if (!merged.sent.length && !merged.skipped.length && errors.length) {
    merged.error = errors.find((e) => e !== "No one to send it to") ?? errors[0];
  }
  return merged;
}

async function workspaceAdminIds(workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, "admin")));
  return rows.map((r) => r.userId);
}

/** Sends one alert to whoever the credential's scope says. */
export async function sendAlert(
  ref: CredentialRef,
  outcome: CheckOutcome,
  alert: Alert,
  now: Date,
): Promise<NotifyResult> {
  const notice = noticeFor(ref, outcome, alert, now);
  const link = "/settings#my-tokens";
  if (ref.scope === "person" && ref.userId) {
    return notify({
      kind: alert.kind,
      toUserIds: [ref.userId],
      workspaceId: ref.workspaceId,
      ...notice,
      link,
    });
  }
  if (ref.workspaceId) {
    // The workspace's admins manage its credentials.
    const wsAdmins = await workspaceAdminIds(ref.workspaceId).catch((): string[] => []);
    return notify({
      kind: alert.kind,
      toUserIds: wsAdmins,
      workspaceId: ref.workspaceId,
      ...notice,
      link,
    });
  }
  const deploymentAdmins = (await listDeploymentAdmins().catch(() => [])).map((a) => a.id);
  return notify({
    kind: alert.kind,
    toUserIds: deploymentAdmins,
    workspaceId: null,
    ...notice,
    link,
  });
}
