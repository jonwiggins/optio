"use client";

import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { notifyApi, type DigestChoice, type DigestVia } from "@/lib/notify-api";
import { SectionCard } from "@/components/ui/section-card";
import { Switch } from "@/components/connections/provider-fields";
import { BTN_SECONDARY, Field, INPUT } from "../settings/settings-ui";
import { ChatTestStatus } from "./my-chat-hook";

/**
 * Settings → Notifications → Daily digest (docs/notifications.md): once a
 * day, at the hour the person picks in their time zone, what waits for them,
 * what failed and what merged — by email, on their chat hook, or both.
 * Nothing to say, nothing sent. Each change saves at once.
 */

export const DEFAULT_DIGEST: DigestChoice = {
  enabled: false,
  hour: 8,
  timeZone: "UTC",
  via: "email",
};

/** This browser's time zone (what a first "on" picks). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function MyDigest({
  digest,
  hasHook,
  emailAvailable,
  onSave,
}: {
  digest: DigestChoice;
  hasHook: boolean;
  emailAvailable: boolean;
  onSave: (patch: Partial<DigestChoice>) => Promise<void>;
}) {
  const [zone, setZone] = useState(digest.timeZone);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const here = browserTimeZone();

  const turn = (on: boolean) =>
    // Turning it on for the first time takes this browser's zone over the default UTC.
    onSave(
      on && digest.timeZone === DEFAULT_DIGEST.timeZone && here !== DEFAULT_DIGEST.timeZone
        ? { enabled: true, timeZone: here }
        : { enabled: on },
    ).then(() => {
      if (on && digest.timeZone === DEFAULT_DIGEST.timeZone) setZone(here);
    });

  const sendNow = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await notifyApi.sendMyDigestNow();
      const where = r.via.map((v) => (v === "email" ? "by email" : "to your chat hook"));
      setResult(
        r.ok
          ? {
              ok: true,
              text: `Sent ${where.join(" and ")}${r.empty ? " (nothing to report today)" : ""}.`,
            }
          : { ok: false, text: `Not sent: ${r.error ?? "no channel to send it on"}` },
      );
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "Couldn't send it" });
    } finally {
      setBusy(false);
    }
  };

  const viaOptions: Array<{ value: DigestVia; label: string; ok: boolean }> = [
    { value: "email", label: "Email", ok: emailAvailable },
    { value: "chat", label: "Your chat hook", ok: hasHook },
    { value: "both", label: "Both", ok: emailAvailable && hasHook },
  ];

  return (
    <SectionCard
      id="my-digest"
      label="Daily digest"
      hint="One message a day with what waits for you"
      summary={digest.enabled ? `Every day at ${hourLabel(digest.hour)}` : "Off"}
      bodyClassName="p-4 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-text-muted flex items-start gap-2">
          <CalendarClock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Merge requests waiting for you, work that needs you, what failed and what merged since
            the last digest — your work and your teams&apos;. Nothing happened, nothing sent.
          </span>
        </p>
        <Switch checked={digest.enabled} onChange={turn} label="Send me a daily digest" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="At">
          <select
            aria-label="Digest hour"
            value={digest.hour}
            onChange={(e) => void onSave({ hour: Number(e.target.value) })}
            className={INPUT}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Time zone"
          help={
            zone !== here ? (
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setZone(here);
                  void onSave({ timeZone: here });
                }}
              >
                Use this browser&apos;s ({here})
              </button>
            ) : undefined
          }
        >
          <input
            aria-label="Digest time zone"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            onBlur={() => {
              if (zone.trim() && zone.trim() !== digest.timeZone) {
                void onSave({ timeZone: zone.trim() }).catch(() => setZone(digest.timeZone));
              }
            }}
            placeholder="Europe/Berlin"
            className={INPUT}
          />
        </Field>
        <Field label="Send it by">
          <select
            aria-label="Send the digest by"
            value={digest.via}
            onChange={(e) => void onSave({ via: e.target.value as DigestVia })}
            className={INPUT}
          >
            {viaOptions.map((o) => (
              <option key={o.value} value={o.value} disabled={!o.ok && o.value !== digest.via}>
                {o.label}
                {o.ok ? "" : o.value === "email" ? " (email isn't set up)" : " (set a hook first)"}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-border/60">
        <button type="button" onClick={sendNow} disabled={busy} className={BTN_SECONDARY}>
          {busy ? "Sending…" : "Send me one now"}
        </button>
        <ChatTestStatus result={result} />
      </div>
    </SectionCard>
  );
}
