"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import {
  ROUND_TRIP_STEPS,
  ROUND_TRIP_STEP_LABELS,
  roundTripSettings,
  roundTripSupport,
  type RoundTripStep,
  type RoundTripSupport,
  type TicketFollowUpMode,
  type TicketRoundTripSettings,
} from "@optio/shared";
import { Disclosure } from "@/components/ui/disclosure";
import { Segmented } from "@/components/ui/segmented";
import {
  ticketRoundTripApi,
  type RoundTripCheck,
  type TicketStatusOption,
} from "@/lib/ticket-round-trip-api";
import { BTN_HEADER, BTN_PRIMARY, Field, HELP, INPUT } from "./settings-ui";

/**
 * A ticket provider's round trip (docs/ticket-round-trip.md), under its row
 * in Settings → Integrations → Tickets, for every source with one (GitHub,
 * GitLab, Jira, Linear, Notion): whether it runs (off until switched on),
 * what Optio writes on the tickets it works on — comments with links to the
 * run and the merge request, the work's link, a status per step picked from
 * the service's statuses — and which comments on a ticket resume the work.
 * Test reads one ticket's status and says which mapped statuses it can reach
 * from there, without moving it. The API refuses whoever may not change the
 * provider.
 */

const FOLLOW_UPS: Array<{ value: TicketFollowUpMode; label: string; help: string }> = [
  {
    value: "any",
    label: "Any comment",
    help: "A new comment by a person (not the provider's own account) resumes work that waits or has its merge request open. Comments from before you allowed them don't count.",
  },
  {
    value: "mention",
    label: "Mentions only",
    help: "Only a comment that starts with /optio, mentions @optio or the provider's account. Comments from before you allowed them don't count.",
  },
  { value: "off", label: "Off", help: "Comments on the ticket never resume the work." },
];

const OUTCOME: Record<"ready" | "here" | "unreachable", string> = {
  ready: "can move there now",
  here: "is there already",
  unreachable: "no transition leads there from here",
};

/** How the work's link is kept, in words, per kind of link. */
const LINK_HELP: Record<NonNullable<RoundTripSupport["link"]>, string> = {
  "remote-link": "One remote link per piece of work, updated as it goes (never a second one).",
  comment: "One comment by Optio per piece of work, edited as it goes (never a second one).",
  attachment:
    "One link attachment per piece of work, moved from the run to the merge request (never a second one).",
};

export function TicketRoundTrip({
  provider,
}: {
  provider: { id: string; source: string; config?: unknown };
}) {
  const support = roundTripSupport(provider.source);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<TicketRoundTripSettings>(() =>
    roundTripSettings(provider.config),
  );
  const [statuses, setStatuses] = useState<TicketStatusOption[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [issueKey, setIssueKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<RoundTripCheck | null>(null);

  useEffect(() => {
    if (!open || !support?.statuses || statuses || statusError) return;
    ticketRoundTripApi
      .statuses(provider.id)
      .then((r) => setStatuses(r.statuses))
      .catch((err) => setStatusError(err instanceof Error ? err.message : String(err)));
  }, [open, support?.statuses, provider.id, statuses, statusError]);

  const setStep = (step: RoundTripStep, status: string) =>
    setSettings((s) => ({ ...s, transitions: { ...s.transitions, [step]: status } }));

  const save = async () => {
    setSaving(true);
    try {
      const { roundTrip } = await ticketRoundTripApi.save(provider.id, settings);
      setSettings(roundTrip);
      toast.success("Round trip saved");
    } catch (err) {
      toast.error("Couldn't save the round trip", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    try {
      setCheck(await ticketRoundTripApi.check(provider.id, issueKey.trim(), settings.transitions));
    } catch (err) {
      setCheck({
        ok: false,
        issueKey: issueKey.trim(),
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setChecking(false);
    }
  };

  /** The saved status stays pickable even when the server no longer lists it. */
  const optionsFor = (current: string) => {
    const names = (statuses ?? []).map((s) => s.name);
    return current && !names.includes(current) ? [current, ...names] : names;
  };

  if (!support) return null;

  return (
    <div className="ml-10" data-testid={`round-trip-${provider.id}`}>
      <Disclosure
        open={open}
        onToggle={() => setOpen((o) => !o)}
        label={settings.enabled ? "Round trip (on)" : "Round trip"}
      >
        <div className="space-y-4 p-3 rounded-lg border border-border bg-bg">
          <label className="flex items-start gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.enabled}
              onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
            />
            <span>
              Write back to the {support.name} tickets Optio works on
              <span className={`block font-normal ${HELP}`}>
                Off, the tickets get one comment when work starts, as before. On, they hear how the
                work goes as set below, and a new comment can resume it.
              </span>
            </span>
          </label>
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={settings.comments}
                onChange={(e) => setSettings((s) => ({ ...s, comments: e.target.checked }))}
              />
              <span>
                Comment on the ticket
                <span className={`block ${HELP}`}>
                  When work starts (a link to the run), when its merge request opens, when it
                  merges, and when it fails or waits for a person (with the reason).
                </span>
              </span>
            </label>
            {support.link && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={settings.remoteLink}
                  onChange={(e) => setSettings((s) => ({ ...s, remoteLink: e.target.checked }))}
                />
                <span>
                  Link the run, then the merge request
                  <span className={`block ${HELP}`}>{LINK_HELP[support.link]}</span>
                </span>
              </label>
            )}
          </div>

          <Field
            label="Move the ticket"
            help={
              statusError
                ? `Couldn't read the statuses: ${statusError}`
                : `${support.statusHelp} Leave a step empty to keep the ticket where it is.`
            }
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(ROUND_TRIP_STEPS as readonly RoundTripStep[]).map((step) => (
                <label key={step} className="text-xs text-text-muted">
                  {ROUND_TRIP_STEP_LABELS[step]}
                  <select
                    aria-label={`Status when: ${ROUND_TRIP_STEP_LABELS[step]}`}
                    className={INPUT}
                    value={settings.transitions[step]}
                    disabled={!statuses && !statusError}
                    onChange={(e) => setStep(step, e.target.value)}
                  >
                    <option value="">Leave it</option>
                    {optionsFor(settings.transitions[step]).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </Field>

          <Field
            label={`Follow-ups from ${support.name}`}
            help={FOLLOW_UPS.find((f) => f.value === settings.followUps)?.help}
          >
            <Segmented<TicketFollowUpMode>
              aria-label={`Follow-ups from ${support.name}`}
              value={settings.followUps}
              onChange={(v) => setSettings((s) => ({ ...s, followUps: v }))}
              options={FOLLOW_UPS.map((f) => ({ value: f.value, label: f.label }))}
            />
          </Field>

          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-text-muted">
              Test on a ticket
              <input
                aria-label="Issue key"
                className={INPUT}
                placeholder={support.example}
                value={issueKey}
                onChange={(e) => setIssueKey(e.target.value)}
              />
            </label>
            <button
              type="button"
              className={BTN_HEADER}
              disabled={!issueKey.trim() || checking}
              onClick={runCheck}
              title="Read the ticket's status and where it can go; nothing moves"
            >
              {checking ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3 h-3" />
              )}
              Test
            </button>
            <button
              type="button"
              className={`${BTN_PRIMARY} ml-auto`}
              disabled={saving}
              onClick={save}
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save
            </button>
          </div>

          {check && (
            <div className="text-xs space-y-1" data-testid="round-trip-check">
              {check.ok ? (
                <>
                  <p className="flex items-center gap-1.5 text-success">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    {check.issueKey} is in {check.status ?? "an unknown status"}
                    {check.available?.length
                      ? `; it can move to ${check.available.join(", ")}`
                      : ""}
                    .
                  </p>
                  {(check.steps ?? []).map((s) => (
                    <p
                      key={s.step}
                      className={s.outcome === "unreachable" ? "text-warning" : "text-text-muted"}
                    >
                      {ROUND_TRIP_STEP_LABELS[s.step]} → {s.status}: {OUTCOME[s.outcome]}
                    </p>
                  ))}
                  {!check.steps?.length && (
                    <p className="text-text-muted">No status moves are saved yet.</p>
                  )}
                </>
              ) : (
                <p className="flex items-center gap-1.5 text-error">
                  <XCircle className="w-3.5 h-3.5 shrink-0" />
                  {check.error ?? "The test failed"}
                </p>
              )}
            </div>
          )}
        </div>
      </Disclosure>
    </div>
  );
}
