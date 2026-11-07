"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Mail, MessageSquare, RotateCcw, Trash2 } from "lucide-react";
import { notifyApi, type OutboxView } from "@/lib/notify-api";
import { useCurrentUser } from "@/hooks/use-current-user";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_ROW,
  BTN_ROW_DANGER,
  BTN_SECONDARY,
  BTN_TEXT,
  CardFooter,
  SkeletonCard,
} from "./settings-ui";

/**
 * Settings → Notifications → Undelivered (docs/notifications.md "When the
 * relay is down"): emails and chat posts Optio retried until it gave up, or
 * that the relay or the chat refused for good. Deployment admins only (the
 * whole deployment's, like the relay): retry them once the cause is fixed,
 * or discard them.
 */

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "");

function retryText(r: OutboxView["retry"]): string {
  const base = r.baseSeconds >= 60 ? `${Math.round(r.baseSeconds / 60)} min` : `${r.baseSeconds} s`;
  return `Each email and chat post is tried ${r.attempts} times, waiting ${base} and then twice as long each time. What still fails is kept here for ${r.deadLetterDays} days.`;
}

export function UndeliveredNotifications() {
  const { isDeploymentAdmin, loaded } = useCurrentUser();
  const [view, setView] = useState<OutboxView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    notifyApi
      .getOutbox()
      .then((v) => {
        setView(v);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    if (loaded && isDeploymentAdmin) load();
  }, [loaded, isDeploymentAdmin, load]);

  if (!loaded || !isDeploymentAdmin) return null;
  const label = "Undelivered";
  const hint = "Emails and chat posts Optio couldn't deliver";
  if (failed) {
    return (
      <SectionCard id="undelivered" label={label} hint={hint}>
        <p className="text-xs text-error">Couldn&apos;t load what is undelivered.</p>
      </SectionCard>
    );
  }
  if (!view) return <SkeletonCard id="undelivered" label={label} hint={hint} rows={2} />;

  const act = async (what: "retry" | "discard", ids?: string[]) => {
    setBusy(`${what}:${ids?.[0] ?? "all"}`);
    try {
      if (what === "retry") {
        const r = await notifyApi.retryOutbox(ids);
        toast.success(r.retried === 1 ? "Trying it again" : `Trying ${r.retried} again`);
      } else {
        const r = await notifyApi.discardOutbox(ids);
        toast.success(r.discarded === 1 ? "Discarded" : `Discarded ${r.discarded}`);
      }
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That didn't work");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard
      id="undelivered"
      label={label}
      hint={hint}
      summary={view.dead ? `${view.dead} undelivered` : "All delivered"}
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted">{retryText(view.retry)}</p>
      {view.pending > 0 && (
        <p className="text-xs" data-testid="outbox-pending">
          {view.pending} waiting to be delivered
          {view.oldestPendingAt ? `, the oldest since ${when(view.oldestPendingAt)}` : ""}. Optio
          keeps trying.
        </p>
      )}
      {view.items.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing undelivered.</p>
      ) : (
        <ul className="divide-y divide-border/60" aria-label="Undelivered notifications">
          {view.items.map((item) => (
            <li key={item.id} className="py-2 flex items-start gap-3">
              {item.channel === "email" ? (
                <Mail className="w-4 h-4 mt-0.5 shrink-0 text-text-muted" />
              ) : (
                <MessageSquare className="w-4 h-4 mt-0.5 shrink-0 text-text-muted" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{item.summary}</p>
                <p className="text-xs text-text-muted truncate">
                  To {item.to} · {item.attempts} {item.attempts === 1 ? "try" : "tries"} · gave up{" "}
                  {when(item.deadAt)}
                </p>
                {item.lastError && (
                  <p className="text-xs text-error break-words">{item.lastError}</p>
                )}
              </div>
              <button
                type="button"
                className={BTN_ROW}
                disabled={busy !== null}
                onClick={() => act("retry", [item.id])}
                aria-label={`Retry: ${item.summary}`}
                title="Try again"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                className={BTN_ROW_DANGER}
                disabled={busy !== null}
                onClick={() => act("discard", [item.id])}
                aria-label={`Discard: ${item.summary}`}
                title="Discard"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {view.items.length > 1 && (
        <CardFooter note={`${view.dead} in all`}>
          <button
            type="button"
            className={BTN_TEXT}
            disabled={busy !== null}
            onClick={() => act("discard")}
          >
            Discard all
          </button>
          <button
            type="button"
            className={BTN_SECONDARY}
            disabled={busy !== null}
            onClick={() => act("retry")}
          >
            Retry all
          </button>
        </CardFooter>
      )}
    </SectionCard>
  );
}
