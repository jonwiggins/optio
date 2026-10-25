/**
 * Credential health (docs/credential-health.md): what the last check found
 * about each token Optio holds — Settings → System health and the caller's
 * own on Settings → My tokens. The API is routes/credential-health.ts.
 */
import { request } from "@/lib/api-client";

export type CredentialStatus = "ok" | "warning" | "error" | "unknown";

export interface CredentialHealthRow {
  /** What the credential is (`gitlab:org`, `gateway:<id>:user:<id>`, …): the Check now key. */
  key: string;
  kind: "github" | "gitlab" | "gateway" | "jira" | "remote_workspace";
  /** "GitLab token", "Gateway token · LiteLLM", "Jira · jira.example.test". */
  label: string;
  scope: "organization" | "team" | "person";
  /** Whose: a person's name, "Team · Platform" or "Organization". */
  owner: { name: string; userId: string | null; teamId: string | null };
  status: CredentialStatus;
  /** One sentence that says what is wrong and, often, where to fix it. */
  reason: string | null;
  expiresAt: string | null;
  checkedAt: string;
  /** What the check read: host, scopes, spend, maxBudget, budgetResetAt, account, … */
  details: Record<string, unknown>;
}

export interface CredentialHealthList {
  rows: CredentialHealthRow[];
  /** The caller is a deployment admin: "Check all" starts a pass. */
  canCheckAll: boolean;
  lastCheckedAt: string | null;
}

export const credentialHealthApi = {
  /** The rows the caller may see, worst first; `mine`: their own only. */
  list: (mine = false) =>
    request<CredentialHealthList>(`/api/credential-health${mine ? "?mine=true" : ""}`),
  check: (key: string) =>
    request<{ row: CredentialHealthRow }>("/api/credential-health/check", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
  checkMine: () =>
    request<{ rows: CredentialHealthRow[] }>("/api/credential-health/check-mine", {
      method: "POST",
    }),
  checkAll: () =>
    request<{ started: boolean }>("/api/credential-health/check-all", { method: "POST" }),
};

const DAY_MS = 86_400_000;

/** "in 7 days", "in 1 day", "expired": how far off an expiry is (whole days, rounded up, as the API counts). */
export function expiresIn(expiresAt: string, now: Date = new Date()): string {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "expired";
  const days = Math.ceil(ms / DAY_MS);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

/** "2026-11-01 00:00 UTC", as the API's reasons and emails write it. */
export function formatUtc(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "2 failing, 1 warning", or null when every credential is fine. */
export function healthSummary(rows: CredentialHealthRow[]): string | null {
  const count = (s: CredentialStatus) => rows.filter((r) => r.status === s).length;
  const parts = [
    count("error") && `${count("error")} failing`,
    count("warning") && `${count("warning")} ${count("warning") === 1 ? "warning" : "warnings"}`,
    count("unknown") && `${count("unknown")} unknown`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}
