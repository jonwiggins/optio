/**
 * The Audit page's data (docs/audit.md): the API's shapes, the filters as a
 * query string (the list and the export take the same one), and how an
 * entry's details read. The API is `routes/audit.ts`; the action catalog is
 * `AUDIT_ACTION_LABELS` / `AUDIT_ACTION_GROUPS` in @optio/shared.
 */
import { AUDIT_ACTION_GROUPS } from "@optio/shared";

export interface AuditItem {
  id: string;
  time: string;
  workspaceId: string | null;
  workspaceName: string | null;
  actor: { id: string; email: string | null; name: string | null } | null;
  action: string;
  label: string;
  success: boolean;
  clientIp: string | null;
  details: Record<string, unknown>;
}

export interface AuditPage {
  items: AuditItem[];
  total: number;
  limit: number;
  offset: number;
  /** `all` for a deployment admin, `workspace` for a workspace admin. */
  scope: "workspace" | "all";
}

export interface AuditRetention {
  days: number;
  source: "app" | "environment" | "default";
  environmentDays: number;
  lastPrunedAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AuditSettings {
  retention: AuditRetention;
  /** Each entry is also printed to stdout as a JSON line (OPTIO_AUDIT_STDOUT=json). */
  stdout: boolean;
  /** The viewer is a deployment admin. */
  canChange: boolean;
}

export type AuditExportFormat = "csv" | "jsonl";

/** What the page's filter bar holds. Empty strings mean "any". */
export interface AuditFilters {
  /** Deployment admins: every workspace or the current one. */
  workspace: "all" | "current";
  userId: string;
  teamId: string;
  /** An `AUDIT_ACTION_GROUPS` id, or "" for every action. */
  group: string;
  /** Free text: action names or prefixes, comma-separated (`team.join, pr.merge`). */
  action: string;
  /** YYYY-MM-DD, the first day included. */
  from: string;
  /** YYYY-MM-DD, the last day included. */
  to: string;
  outcome: "" | "success" | "failure";
}

/** YYYY-MM-DD of a date, in UTC (the API reads a bare date as a UTC day). */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The page's opening filters: everything of the last seven days. */
export function defaultAuditFilters(now: Date = new Date()): AuditFilters {
  return {
    workspace: "all",
    userId: "",
    teamId: "",
    group: "",
    action: "",
    from: isoDay(new Date(now.getTime() - 7 * 86_400_000)),
    to: "",
    outcome: "",
  };
}

/** The action names a filter state asks for: its group's prefixes plus any typed ones. */
export function auditActions(f: Pick<AuditFilters, "group" | "action">): string[] {
  const group = AUDIT_ACTION_GROUPS.find((g) => g.id === f.group);
  const typed = f.action
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return [...(group?.prefixes ?? []), ...typed];
}

/**
 * The query string for `GET /api/audit` and `/api/audit/export`. `scoped`
 * says whether the viewer may pick the workspace (a deployment admin).
 */
export function auditQuery(
  f: AuditFilters,
  opts: {
    scoped?: boolean;
    limit?: number;
    offset?: number;
    format?: AuditExportFormat;
  } = {},
): string {
  const q = new URLSearchParams();
  if (opts.scoped) q.set("workspace", f.workspace);
  if (f.userId) q.set("userId", f.userId);
  if (f.teamId) q.set("teamId", f.teamId);
  const actions = auditActions(f);
  if (actions.length) q.set("action", actions.join(","));
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.outcome) q.set("outcome", f.outcome);
  if (opts.format) q.set("format", opts.format);
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts.offset !== undefined) q.set("offset", String(opts.offset));
  return q.toString();
}

const DETAIL_LABELS: Record<string, string> = {
  provider: "Provider",
  via: "Via",
  reason: "Reason",
  username: "Tried as",
  email: "Email",
  targetUserId: "Person",
  teamId: "Team",
  role: "Role",
  fields: "Changed",
  retentionDays: "Days",
  prUrl: "Merge request",
  prNumber: "Number",
  mergeMethod: "Method",
  confirmedBy: "Confirmed by",
  confirmedAt: "Confirmed at",
  name: "Name",
  scope: "Scope",
  type: "Type",
  kind: "Kind",
  count: "Count",
};

/** Names for the ids an entry carries (people, teams), when the page knows them. */
export interface AuditNames {
  people: Record<string, string>;
  teams: Record<string, string>;
}

/** An entry's details as label / text pairs, ids named when known, in a stable order. */
export function auditDetails(
  details: Record<string, unknown>,
  names: AuditNames = { people: {}, teams: {} },
): Array<{ key: string; label: string; text: string }> {
  const order = Object.keys(DETAIL_LABELS);
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  return Object.entries(details)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, v]) => {
      let text = Array.isArray(v)
        ? v.join(", ")
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
      if ((key === "targetUserId" || key === "confirmedBy") && names.people[text]) {
        text = names.people[text];
      } else if (key === "teamId" && names.teams[text]) {
        text = names.teams[text];
      } else if (key === "confirmedAt") {
        const d = new Date(text);
        if (!Number.isNaN(d.getTime())) text = d.toLocaleString();
      }
      return { key, label: DETAIL_LABELS[key] ?? key, text };
    });
}

/** Where the retention comes from, in words. */
export function retentionSource(r: AuditRetention): string {
  switch (r.source) {
    case "app":
      return "set here by a deployment admin";
    case "environment":
      return "the deployment's OPTIO_AUDIT_RETENTION_DAYS";
    default:
      return "the default";
  }
}
