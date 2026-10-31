"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { AUDIT_ACTION_GROUPS } from "@optio/shared";
import { api } from "@/lib/api-client";
import {
  auditDetails,
  auditQuery,
  defaultAuditFilters,
  type AuditExportFormat,
  type AuditFilters,
  type AuditItem,
  type AuditNames,
} from "@/lib/audit";
import { cn, formatRelativeTime } from "@/lib/utils";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { inputClass } from "@/components/ui/input";
import { AuditRetentionCard } from "./audit-retention-card";

const PAGE = 100;
const FIELD = inputClass({ size: "sm" });
const LABEL = "block text-[11px] font-medium text-text-muted mb-1";

/** Who did it, in words: a person, Optio itself, or nobody signed in. */
function actorText(item: AuditItem): string {
  if (item.actor) return item.actor.name || item.actor.email || item.actor.id;
  if (item.action === "pr.merge") return "Optio (automatic)";
  if (item.action.startsWith("auth.")) return "Not signed in";
  return "Optio";
}

function AuditRow({
  item,
  names,
  showWorkspace,
  onPerson,
}: {
  item: AuditItem;
  names: AuditNames;
  showWorkspace: boolean;
  onPerson: (userId: string) => void;
}) {
  const details = auditDetails(item.details, names);
  return (
    <li className="px-4 py-2.5 hover:bg-bg-hover/40 transition-colors" data-testid="audit-row">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        {item.actor ? (
          <button
            type="button"
            className="font-medium text-text hover:underline"
            title="Show only this person's entries"
            onClick={() => onPerson(item.actor!.id)}
          >
            {actorText(item)}
          </button>
        ) : (
          <span className="font-medium text-text-muted">{actorText(item)}</span>
        )}
        <span className="text-text">{item.label}</span>
        <span
          className={cn(
            "px-1.5 py-px rounded text-[10px] font-medium uppercase tracking-wider",
            item.success ? "bg-success/10 text-success" : "bg-error/10 text-error",
          )}
        >
          {item.success ? "ok" : "refused"}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
        <time dateTime={item.time} title={new Date(item.time).toLocaleString()}>
          {formatRelativeTime(item.time)}
        </time>
        <code className="font-mono">{item.action}</code>
        {item.clientIp && <span className="font-mono">from {item.clientIp}</span>}
        {showWorkspace && (
          <span>{item.workspaceName ?? (item.workspaceId ? item.workspaceId : "Deployment")}</span>
        )}
        {details.map((d) => (
          <span key={d.key} className="inline-flex gap-1">
            <span className="text-text-muted/70">{d.label}</span>
            <span className="text-text break-all">{d.text}</span>
          </span>
        ))}
      </div>
    </li>
  );
}

/**
 * The Audit page (docs/audit.md): who did what, from where. Workspace admins
 * read their workspace's entries; deployment admins every workspace's and
 * the deployment-wide ones. Filters by person, action, time and
 * outcome; the same filters export as CSV or JSON lines.
 */
export function AuditTrail() {
  const { user, isAdmin, isDeploymentAdmin, loaded } = useCurrentUser();
  const allowed = isAdmin || isDeploymentAdmin;
  const [filters, setFilters] = useState<AuditFilters>(() => defaultAuditFilters());
  const [items, setItems] = useState<AuditItem[]>([]);
  const [total, setTotal] = useState(0);
  const [scope, setScope] = useState<"workspace" | "all">("workspace");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);
  const [exporting, setExporting] = useState<AuditExportFormat | null>(null);

  const set = (patch: Partial<AuditFilters>) => setFilters((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!loaded || !allowed || !user?.workspaceId) return;
    api
      .listWorkspaceMembers(user.workspaceId)
      .then((r) =>
        setPeople(
          r.members
            .map((m) => ({ id: m.userId, name: m.displayName || m.email }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ),
      )
      .catch(() => {});
  }, [loaded, allowed, user?.workspaceId]);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api.listAudit(
          auditQuery(filters, { scoped: isDeploymentAdmin, limit: PAGE, offset }),
        );
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setTotal(page.total);
        setScope(page.scope);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read the audit trail");
      } finally {
        setLoading(false);
      }
    },
    [filters, isDeploymentAdmin],
  );

  useEffect(() => {
    if (loaded && allowed) void load(0);
  }, [loaded, allowed, load]);

  const names: AuditNames = useMemo(
    () => ({
      people: Object.fromEntries(people.map((p) => [p.id, p.name])),
      teams: {},
    }),
    [people],
  );

  const download = async (format: AuditExportFormat) => {
    setExporting(format);
    try {
      const { blob, filename } = await api.exportAudit(
        auditQuery(filters, { scoped: isDeploymentAdmin, format }),
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not export the audit trail");
    } finally {
      setExporting(null);
    }
  };

  if (loaded && !allowed) {
    return (
      <div className="page-column py-6">
        <EmptyState
          icon={ShieldCheck}
          title="The audit trail is for admins"
          description="Workspace admins read their workspace's audit trail; deployment admins read every workspace's."
        />
      </div>
    );
  }

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={ShieldCheck}
        title="Audit"
        description="Who did what, from where: sign-ins, merges, tokens, membership and settings changes, and every other action Optio records."
        meta={
          <span data-testid="audit-total">
            {total} entr{total === 1 ? "y" : "ies"}
            {scope === "all" && filters.workspace === "all" ? " in every workspace" : ""}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => download("csv")}
              disabled={!!exporting}
            >
              <Download className="w-3.5 h-3.5" />
              {exporting === "csv" ? "Exporting…" : "CSV"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => download("jsonl")}
              disabled={!!exporting}
            >
              <Download className="w-3.5 h-3.5" />
              {exporting === "jsonl" ? "Exporting…" : "JSON lines"}
            </Button>
            <button
              onClick={() => load(0)}
              className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            </button>
          </div>
        }
      />

      <div className="space-y-6">
        <div className="space-y-3">
          {isDeploymentAdmin && (
            <Segmented
              aria-label="Workspaces"
              surface="card"
              value={filters.workspace}
              onChange={(v) => set({ workspace: v as AuditFilters["workspace"] })}
              options={[
                { value: "all", label: "All workspaces" },
                { value: "current", label: "This workspace" },
              ]}
            />
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label htmlFor="audit-person" className={LABEL}>
                Person
              </label>
              <select
                id="audit-person"
                className={FIELD}
                value={filters.userId}
                onChange={(e) => set({ userId: e.target.value })}
              >
                <option value="">Everyone</option>
                {filters.userId && !names.people[filters.userId] && (
                  <option value={filters.userId}>{filters.userId}</option>
                )}
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="audit-action" className={LABEL}>
                Action
              </label>
              <select
                id="audit-action"
                className={FIELD}
                value={filters.group}
                onChange={(e) => set({ group: e.target.value })}
              >
                <option value="">Every action</option>
                {AUDIT_ACTION_GROUPS.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="audit-action-text" className={LABEL}>
                Action names
              </label>
              <input
                id="audit-action-text"
                className={cn(FIELD, "font-mono")}
                placeholder="team.join, pr.merge"
                value={filters.action}
                onChange={(e) => set({ action: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="audit-from" className={LABEL}>
                From
              </label>
              <input
                id="audit-from"
                type="date"
                className={FIELD}
                value={filters.from}
                onChange={(e) => set({ from: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="audit-to" className={LABEL}>
                To
              </label>
              <input
                id="audit-to"
                type="date"
                className={FIELD}
                value={filters.to}
                onChange={(e) => set({ to: e.target.value })}
              />
            </div>
            <div className="col-span-2 flex items-end">
              <Segmented
                aria-label="Outcome"
                surface="card"
                value={filters.outcome}
                onChange={(v) => set({ outcome: v as AuditFilters["outcome"] })}
                options={[
                  { value: "", label: "Any outcome" },
                  { value: "success", label: "Succeeded" },
                  { value: "failure", label: "Refused or failed" },
                ]}
              />
            </div>
          </div>
        </div>

        {error ? (
          <EmptyState
            icon={ShieldCheck}
            title="Couldn't read the audit trail"
            description={error}
          />
        ) : loading && items.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-12 skeleton-shimmer rounded-lg" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No entries"
            description="Nothing matches these filters. Widen the dates or clear a filter."
          />
        ) : (
          <Panel
            title="Entries"
            actions={
              <span className="text-text-muted tabular-nums">
                {items.length} of {total}
              </span>
            }
          >
            <ul className="divide-y divide-border/40">
              {items.map((item) => (
                <AuditRow
                  key={item.id}
                  item={item}
                  names={names}
                  showWorkspace={scope === "all" && filters.workspace === "all"}
                  onPerson={(userId) => set({ userId })}
                />
              ))}
            </ul>
          </Panel>
        )}

        {items.length < total && !error && (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              disabled={loading}
              onClick={() => load(items.length)}
            >
              {loading ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}

        <AuditRetentionCard />
      </div>
    </div>
  );
}
