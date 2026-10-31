"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { AUDIT_RETENTION_MAX_DAYS } from "@optio/shared";
import { api } from "@/lib/api-client";
import { retentionSource, type AuditSettings } from "@/lib/audit";
import { useCurrentUser } from "@/hooks/use-current-user";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_HEADER,
  BTN_TEXT,
  HELP,
  INPUT,
  LABEL,
  SkeletonCard,
} from "@/components/settings/settings-ui";
import { formatRelativeTime } from "@/lib/utils";

/**
 * How long the audit trail is kept (docs/audit.md), and whether each entry
 * also goes to stdout for the SIEM. Workspace admins read it; a deployment
 * admin changes it (the setting is deployment-wide). On the Audit page, and
 * under Settings → Access with a link to the page (`link`). Renders nothing
 * for people who can't read the audit trail.
 */
export function AuditRetentionCard({ link = false }: { link?: boolean }) {
  const { isAdmin, isDeploymentAdmin, loaded } = useCurrentUser();
  const [settings, setSettings] = useState<AuditSettings | null>(null);
  const [days, setDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const allowed = isAdmin || isDeploymentAdmin;

  useEffect(() => {
    if (!loaded || !allowed) return;
    api
      .getAuditSettings()
      .then((s) => {
        setSettings(s);
        setDays(String(s.retention.days));
      })
      .catch(() => setFailed(true));
  }, [loaded, allowed]);

  if (!loaded || !allowed || failed) return null;
  const label = "Audit trail";
  const hint = "Who did what, from where";
  if (!settings) return <SkeletonCard id="audit-trail" label={label} hint={hint} rows={1} />;

  const r = settings.retention;
  const save = async (value: number | null) => {
    setSaving(true);
    try {
      const next = await api.setAuditRetention(value);
      setSettings(next);
      setDays(String(next.retention.days));
      toast.success(`The audit trail is kept for ${next.retention.days} days`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the retention");
    } finally {
      setSaving(false);
    }
  };
  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= AUDIT_RETENTION_MAX_DAYS;

  return (
    <SectionCard
      id="audit-trail"
      label={label}
      hint={hint}
      summary={`Kept ${r.days} days`}
      actions={
        link && (
          <Link href="/audit" className={BTN_HEADER}>
            <ShieldCheck className="w-3.5 h-3.5" />
            Open
          </Link>
        )
      }
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted" data-testid="audit-retention">
        Sign-ins, merges, tokens, membership and settings changes are kept for{" "}
        <strong>{r.days} days</strong> ({retentionSource(r)}), then removed once a day.
        {r.lastPrunedAt && <> Last pruned {formatRelativeTime(r.lastPrunedAt)}.</>}
      </p>
      <p className="text-xs text-text-muted" data-testid="audit-stdout">
        {settings.stdout
          ? "Each entry is also printed to the API's log as one JSON line for your SIEM."
          : "Entries are not copied to the API's log (OPTIO_AUDIT_STDOUT=json turns that on)."}
      </p>
      {settings.canChange ? (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <div>
            <label htmlFor="audit-retention-days" className={LABEL}>
              Keep for (days)
            </label>
            <input
              id="audit-retention-days"
              type="number"
              min={1}
              max={AUDIT_RETENTION_MAX_DAYS}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className={`${INPUT} w-32`}
            />
          </div>
          <button
            type="button"
            className={BTN_HEADER}
            disabled={saving || !valid || parsed === r.days}
            onClick={() => save(parsed)}
          >
            {saving ? "Saving…" : "Save retention"}
          </button>
          {r.source === "app" && (
            <button type="button" className={BTN_TEXT} disabled={saving} onClick={() => save(null)}>
              Use the deployment&apos;s {r.environmentDays} days
            </button>
          )}
          {valid && parsed < 7 && (
            <p role="alert" className={HELP}>
              Short retention permanently removes older history, including this settings change.
              Export the trail or keep an external SIEM copy first.
            </p>
          )}
          {!valid && days !== "" && (
            <p className={HELP}>Between 1 and {AUDIT_RETENTION_MAX_DAYS} days.</p>
          )}
        </div>
      ) : (
        <p className={HELP}>A deployment admin changes how long it is kept.</p>
      )}
    </SectionCard>
  );
}
