"use client";

import { useCallback, useEffect, useState } from "react";
import { HeartPulse, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useCurrentUser } from "@/hooks/use-current-user";
import {
  credentialHealthApi,
  expiresIn,
  formatUtc,
  healthSummary,
  type CredentialHealthRow,
  type CredentialStatus,
} from "@/lib/credential-health-api";
import { cn, formatRelativeTime } from "@/lib/utils";
import { SectionCard } from "@/components/ui/section-card";
import { EmptyState } from "@/components/empty-state";
import { BTN_HEADER, BTN_ROW, SkeletonCard } from "./settings-ui";

/**
 * Settings → System health (docs/credential-health.md): what the last
 * check found about each token Optio holds — GitLab, the model gateway,
 * Jira, remote-workspace providers — with whose it is, its status and why, when it expires, when
 * it was checked, and a Check now button. A deployment admin sees every
 * credential (and may check them all at once); a team admin their teams';
 * a workspace admin their workspace's Jira and remote-workspace connections. The
 * person's own are on Settings → My tokens (`MyCredentialHealth`).
 */

const STATUS: Record<CredentialStatus, { label: string; className: string }> = {
  ok: { label: "OK", className: "bg-success/10 text-success" },
  warning: { label: "Warning", className: "bg-warning/10 text-warning" },
  error: { label: "Failing", className: "bg-error/10 text-error" },
  unknown: { label: "Unknown", className: "bg-bg-hover text-text-muted" },
};

export function StatusChip({ status }: { status: CredentialStatus }) {
  const s = STATUS[status];
  return (
    <span
      className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0", s.className)}
      data-testid="health-status"
    >
      {s.label}
    </span>
  );
}

/** Whether the viewer has a System health section to look at. */
export function useSystemHealthVisible(): boolean {
  const { user, isAdmin, isDeploymentAdmin, loaded } = useCurrentUser();
  return loaded && (isDeploymentAdmin || isAdmin || (user?.adminTeamIds?.length ?? 0) > 0);
}

/** One credential: what, whose, status and reason, expiry, last check, Check now. */
export function HealthRow({
  row,
  onChecked,
  showOwner = true,
}: {
  row: CredentialHealthRow;
  onChecked: (row: CredentialHealthRow) => void;
  showOwner?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      const { row: next } = await credentialHealthApi.check(row.key);
      onChecked(next);
    } catch (err) {
      toast.error("Couldn't check it", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" data-testid={`health-row-${row.key}`}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{row.label}</span>
          <StatusChip status={row.status} />
          {showOwner && <span className="text-[11px] text-text-muted">{row.owner.name}</span>}
        </div>
        {row.reason && (
          <p
            className={cn(
              "text-xs",
              row.status === "error"
                ? "text-error"
                : row.status === "warning"
                  ? "text-warning"
                  : "text-text-muted",
            )}
          >
            {row.reason}
          </p>
        )}
        <p className="text-[11px] text-text-muted">
          {row.expiresAt ? (
            <>
              Expires {formatUtc(row.expiresAt)} ({expiresIn(row.expiresAt)})
            </>
          ) : (
            "No expiry reported"
          )}
          {" · "}checked {formatRelativeTime(row.checkedAt)}
        </p>
      </div>
      <button
        type="button"
        onClick={check}
        disabled={busy}
        className={BTN_ROW}
        aria-label={`Check ${row.label} (${row.owner.name}) now`}
      >
        <RefreshCw className={cn("w-3.5 h-3.5", busy && "animate-spin")} />
        {busy ? "Checking…" : "Check now"}
      </button>
    </li>
  );
}

const LIST = "divide-y divide-border/60 rounded-lg border border-border";

export function SystemHealth() {
  const visible = useSystemHealthVisible();
  const [rows, setRows] = useState<CredentialHealthRow[] | null>(null);
  const [canCheckAll, setCanCheckAll] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await credentialHealthApi.list();
      setRows(res.rows);
      setCanCheckAll(res.canCheckAll);
      setLastCheckedAt(res.lastCheckedAt);
      setFailed(null);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Couldn't load the checks");
    }
  }, []);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  if (!visible) return null;
  const label = "Credentials";
  const hint = "GitLab, model gateway, Jira and remote-workspace tokens";
  if (failed) {
    return (
      <SectionCard id="credential-health" label={label} hint={hint}>
        <p className="text-xs text-error">{failed}</p>
      </SectionCard>
    );
  }
  if (!rows) return <SkeletonCard id="credential-health" label={label} hint={hint} rows={3} />;

  const replace = (next: CredentialHealthRow) =>
    setRows((prev) => (prev ?? []).map((r) => (r.key === next.key ? next : r)));
  const checkAll = async () => {
    setStarting(true);
    try {
      await credentialHealthApi.checkAll();
      toast.success("Checking every credential", {
        description: "The rows update as each check finishes.",
      });
      // The pass runs in the background; show what it has done in a moment.
      setTimeout(() => void load(), 5000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start the checks");
    } finally {
      setStarting(false);
    }
  };

  return (
    <SectionCard
      id="credential-health"
      label={label}
      hint={hint}
      summary={healthSummary(rows) ?? (rows.length ? "All working" : undefined)}
      actions={
        canCheckAll && (
          <button type="button" onClick={checkAll} disabled={starting} className={BTN_HEADER}>
            <RefreshCw className={cn("w-3.5 h-3.5", starting && "animate-spin")} />
            Check all
          </button>
        )
      }
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        Optio checks every token it holds on a schedule (every 15 minutes by default) and emails its
        owner 30, 7 and 1 days before it expires, and when it is refused or over budget.{" "}
        {canCheckAll
          ? "You see every credential: the organization's, each team's and each person's."
          : "You see your teams' credentials and your workspace's connections; your own are under My tokens."}
        {lastCheckedAt && <> Last check {formatRelativeTime(lastCheckedAt)}.</>}
      </p>
      {rows.length ? (
        <ul className={LIST} data-testid="credential-health-rows">
          {rows.map((row) => (
            <HealthRow key={row.key} row={row} onChecked={replace} />
          ))}
        </ul>
      ) : (
        <EmptyState
          size="panel"
          icon={HeartPulse}
          title="Nothing checked yet"
          description="Tokens show here after the first check, a minute after Optio starts and on every pass after."
        />
      )}
    </SectionCard>
  );
}

/**
 * The viewer's own credentials, inside Settings → My tokens: their GitLab
 * and gateway tokens and their remote-workspace / Jira connections, with one Check now
 * for all of them (a token stored a moment ago has no row until then).
 */
export function MyCredentialHealth() {
  const [rows, setRows] = useState<CredentialHealthRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // `Promise.resolve().then`: a client that can't answer (a test's) only leaves it unchecked.
    Promise.resolve()
      .then(() => credentialHealthApi.list(true))
      .then((res) => setRows(res.rows))
      .catch(() => setRows(null));
  }, []);

  const checkMine = async () => {
    setBusy(true);
    try {
      setRows((await credentialHealthApi.checkMine()).rows);
    } catch (err) {
      toast.error("Couldn't check your tokens", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  const replace = (next: CredentialHealthRow) =>
    setRows((prev) => (prev ?? []).map((r) => (r.key === next.key ? next : r)));

  return (
    <div className="space-y-2" data-testid="my-credential-health">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Health</span>
        {rows && rows.length > 0 && (
          <span className="text-[11px] text-text-muted">
            {healthSummary(rows) ?? "All working"}
          </span>
        )}
        <button
          type="button"
          onClick={checkMine}
          disabled={busy}
          className={cn(BTN_ROW, "ml-auto")}
        >
          <RefreshCw className={cn("w-3.5 h-3.5", busy && "animate-spin")} />
          {busy ? "Checking…" : "Check my tokens"}
        </button>
      </div>
      {rows && rows.length > 0 ? (
        <ul className={LIST}>
          {rows.map((row) => (
            <HealthRow key={row.key} row={row} onChecked={replace} showOwner={false} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-muted">
          Not checked yet. Optio checks your tokens on a schedule and emails you before one expires
          or when it stops working.
        </p>
      )}
    </div>
  );
}
