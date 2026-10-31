/**
 * Offboarding from the directory (docs/directory-sync.md): the directory
 * sync's settings and runs, and disabled accounts. Deployment admins only;
 * the API is apps/api/src/routes/directory-sync.ts.
 */
import { request } from "@/lib/api-client";

export interface DirectorySyncSettings {
  enabled: boolean;
  intervalMinutes: number;
  /** Where each value comes from: saved in the app, or the deployment's environment. */
  source: { enabled: "app" | "environment"; intervalMinutes: "app" | "environment" };
  environment: { enabled: boolean; intervalMinutes: number; maxDisablePercent: number };
  maxDisablePercent: number;
}

export type DirectorySyncOutcome =
  | "unchanged"
  | "changed"
  | "disabled"
  | "enabled"
  | "still_disabled"
  | "would_disable"
  | "kept_last_admin"
  | "error";

export interface DirectorySyncRun {
  id: string;
  trigger: "schedule" | "manual";
  startedBy: string | null;
  forced: boolean;
  status: "running" | "ok" | "held" | "failed";
  checked: number;
  changed: number;
  disabled: number;
  enabled: number;
  errors: number;
  error: string | null;
  details: Array<{ userId: string; email: string; outcome: string; reason?: string }>;
  startedAt: string;
  finishedAt: string | null;
}

export interface DisabledPerson {
  id: string;
  email: string;
  displayName: string;
  disabledAt: string;
  reason: string | null;
  reasonLabel: string;
  byHand: boolean;
  disabledBy: { id: string; displayName: string } | null;
  /** The automations Optio paused for them that the viewer may see. */
  paused: Array<{ name: string; kind: string; path: string; workspaceId: string | null }>;
  /** Paused automations in workspaces the viewer doesn't administer. */
  pausedHidden: number;
}

export interface DirectorySyncView {
  settings: DirectorySyncSettings;
  ldapConfigured: boolean;
  /** Why the sync can't run here, when it can't. */
  note: string | null;
  running: boolean;
  lastRun: DirectorySyncRun | null;
  disabledPeople: DisabledPerson[];
  limits: { minIntervalMinutes: number; maxIntervalMinutes: number };
}

export interface AccountChange {
  id: string;
  email: string;
  displayName: string;
  disabled: boolean;
  revokedSessions?: number;
  revokedApiKeys?: number;
  paused?: number;
  resumed?: number;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

export const directorySyncApi = {
  get: () => request<DirectorySyncView>("/api/admin/directory-sync"),
  /** null puts a value back to the deployment's. */
  update: (body: { enabled?: boolean | null; intervalMinutes?: number | null }) =>
    request<DirectorySyncView>("/api/admin/directory-sync", json("PUT", body)),
  run: (force = false) =>
    request<DirectorySyncRun>(
      "/api/admin/directory-sync/run",
      json("POST", force ? { force: true } : {}),
    ),
  disable: (body: { email: string } | { userId: string }) =>
    request<AccountChange>("/api/admin/users/disable", json("POST", body)),
  enable: (userId: string) =>
    request<AccountChange>(`/api/admin/users/${encodeURIComponent(userId)}/enable`, json("POST")),
};
