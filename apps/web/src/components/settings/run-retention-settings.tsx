"use client";

import { useEffect, useState } from "react";
import { api, type RunRetention } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";

/**
 * Settings → Access → Run retention: how long the logs, transcripts and
 * prompts of finished work are kept (docs/log-retention.md). The deployment
 * sets it (`OPTIO_RUN_LOG_RETENTION_DAYS`, chart `retention.runLogsDays`);
 * this card only shows it. Shown to deployment admins only.
 */
export function RunRetentionSettings() {
  const [canEdit, setCanEdit] = useState(false);
  const [retention, setRetention] = useState<RunRetention | null>(null);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then((s) => {
        setCanEdit(s.canEdit);
        if (s.canEdit) return api.getRunRetention().then(setRetention);
      })
      .catch(() => {});
  }, []);

  if (!canEdit || !retention) return null;
  const days = retention.runLogsDays;
  const summary =
    days === null ? "Kept forever" : `Deleted after ${days} ${days === 1 ? "day" : "days"}`;

  return (
    <SectionCard
      label="Run retention"
      hint="Logs, transcripts and prompts of finished work"
      summary={summary}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted" data-testid="run-retention">
        {days === null
          ? "Run logs, session transcripts and prompts are kept until the run is deleted."
          : `The logs, session transcripts and prompts of work that finished more than ${days} ${
              days === 1 ? "day" : "days"
            } ago are deleted. The runs themselves, their cost and the audit trail stay.`}
      </p>
      <p className="text-xs text-text-muted">
        Set by the deployment: <code>retention.runLogsDays</code> in the Helm chart (
        <code>OPTIO_RUN_LOG_RETENTION_DAYS</code>).
      </p>
    </SectionCard>
  );
}
