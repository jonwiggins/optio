"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Mail } from "lucide-react";
import { notifyApi, type ChannelPatch, type MyChannels } from "@/lib/notify-api";
import { SectionCard } from "@/components/ui/section-card";
import { Switch } from "@/components/connections/provider-fields";
import { SkeletonCard } from "@/components/settings/settings-ui";

/**
 * Settings → Notifications → "What reaches you" (docs/notifications.md):
 * per event, email on or off — and chat, once the person set their own chat
 * hook (the "Your chat hook" card below) — and, for a team admin, whether
 * their teams' work counts too; then the daily digest. Each switch saves at
 * once. Email shows even before a relay is set up (the choices wait for
 * it). Push has one place only: the Browser Push card below
 * (NotificationPreferences), with its own per-event switches once this
 * browser is subscribed.
 */
export function MyNotifications() {
  const [data, setData] = useState<MyChannels | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    notifyApi
      .getMyChannels()
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  const label = "What reaches you";
  const hint = "Email and alerts about your work";
  if (failed) {
    return (
      <SectionCard id="my-notifications" label={label} hint={hint}>
        <p className="text-xs text-error">Couldn&apos;t load your notification choices.</p>
      </SectionCard>
    );
  }
  if (!data) return <SkeletonCard id="my-notifications" label={label} hint={hint} rows={3} />;

  const save = async (patch: ChannelPatch, optimistic: MyChannels) => {
    const before = data;
    setData(optimistic);
    try {
      setData(await notifyApi.updateMyChannels(patch));
    } catch (err) {
      setData(before);
      toast.error(err instanceof Error ? err.message : "Couldn't save that choice");
    }
  };

  const setEmail = (kind: string, on: boolean) =>
    save(
      { email: { [kind]: on } },
      { ...data, choices: { ...data.choices, email: { ...data.choices.email, [kind]: on } } },
    );
  const columns = "grid-cols-[minmax(0,1fr)_3.5rem]";

  return (
    <>
      <SectionCard
        id="my-notifications"
        label={label}
        hint={hint}
        summary={data.email.available ? "Email on this Optio" : "No email yet"}
        bodyClassName="p-4 space-y-4"
      >
        <p className="text-xs text-text-muted flex items-start gap-2" data-testid="email-status">
          <Mail className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          {data.email.available ? (
            data.email.address ? (
              <span>
                Emails go to <strong className="text-text">{data.email.address}</strong>, the
                address your sign-in gives Optio.
              </span>
            ) : (
              <span>Your account has no email address, so no emails reach you.</span>
            )
          ) : (
            <span>
              Email isn&apos;t set up on this Optio yet: a deployment admin sets the relay under
              Email below. Your choices apply once it is.
            </span>
          )}
        </p>

        <div role="table" aria-label="Notification choices" className="space-y-1">
          <div
            role="row"
            className={`grid ${columns} gap-3 items-end pb-1 border-b border-border/60`}
          >
            <span role="columnheader" className="text-[11px] text-text-muted">
              Event
            </span>
            <span role="columnheader" className="text-[11px] text-text-muted text-center">
              Email
            </span>
          </div>
          {data.kinds.map((k) => (
            <div role="row" key={k.kind} className={`grid ${columns} gap-3 items-center py-1.5`}>
              <div role="cell" className="min-w-0">
                <p className="text-sm">{k.label}</p>
                <p className="text-xs text-text-muted">{k.description}</p>
              </div>
              <div role="cell" className="flex justify-center">
                <Switch
                  checked={data.choices.email[k.kind] ?? false}
                  onChange={(on) => setEmail(k.kind, on)}
                  label={`Email: ${k.label}`}
                />
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </>
  );
}
