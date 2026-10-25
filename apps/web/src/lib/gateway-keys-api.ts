/**
 * Gateway keys made by Optio, and team budgets (docs/model-gateway.md "Keys
 * Optio makes"). The API is routes/gateway-keys.ts; the shapes match its
 * response schemas. Kept apart from api-client.ts.
 */
import type {
  GatewayKeyDefaults,
  GatewayKeyModes,
  ModelGatewayCapabilities,
  ModelGatewayType,
} from "@optio/shared";
import { api, request, type GatewayTestResult } from "@/lib/api-client";

/** A key Optio made on the gateway (never its value). */
export interface IssuedGatewayKey {
  id: string;
  kind: "person" | "team";
  keyAlias: string | null;
  /** The key's last four characters. */
  keyHint: string | null;
  models: string[];
  maxBudget: number | null;
  budgetDuration: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** What the gateway said at Optio's last check (null = not checked yet). */
  spendUsd: number | null;
  budgetResetAt: string | null;
  checkedAt: string | null;
}

/** A team's gateway budget: read now ("gateway") or as Optio last saw it ("saved"). */
export interface GatewayBudget {
  spend: number | null;
  maxBudget: number | null;
  budgetDuration: string | null;
  budgetResetAt: string | null;
  source: "gateway" | "saved";
}

/** `GET/PUT /api/model-providers/:id/key-issuing` (workspace admins). */
export interface KeyIssuingSettings {
  providerId: string;
  /** The gateway's type and what it supports (absent: an older API, read as LiteLLM). */
  gatewayType?: ModelGatewayType;
  capabilities?: ModelGatewayCapabilities;
  modes: GatewayKeyModes;
  defaults: GatewayKeyDefaults;
  hasAdminKey: boolean;
  /** The catalog's model ids: what "every model" means for a key. */
  catalogModels: string[];
  /** Picked models the catalog no longer serves: new keys leave them out. */
  staleModels: string[];
}

export interface SaveKeyIssuing {
  modes?: Partial<GatewayKeyModes>;
  /** A new admin key for the gateway; null clears it; absent keeps it. */
  adminKey?: string | null;
  defaults?: Partial<GatewayKeyDefaults>;
}

/** `GET /api/gateway/me/key`: how the viewer gets a token, and the key Optio made them. */
/** The gateway a key status is about (`type` absent: read as LiteLLM). */
export interface GatewayRef {
  id: string;
  name: string;
  type?: ModelGatewayType;
}

export interface MyGatewayKey {
  gateway: GatewayRef | null;
  modes: GatewayKeyModes;
  /** "Get my token" works now. */
  canIssue: boolean;
  issued: IssuedGatewayKey | null;
  defaults: Pick<GatewayKeyDefaults, "maxBudget" | "budgetDuration" | "keyDuration">;
}

export interface IssuedKeyResult {
  action: "issue" | "rotate";
  key: IssuedGatewayKey;
  secretName: string;
  test: Omit<GatewayTestResult, "tokenFrom">;
}

/** `GET /api/gateway/teams/:teamId`. */
export interface TeamGatewayKey {
  team: { id: string; name: string };
  gateway: GatewayRef | null;
  modes: GatewayKeyModes;
  canIssue: boolean;
  /** The viewer is the team's admin or a workspace admin. */
  canManage: boolean;
  hasToken: boolean;
  issued: IssuedGatewayKey | null;
  budget: GatewayBudget | null;
  /** A new team key's budget and period. */
  defaults: { maxBudget: number | null; budgetDuration: string | null };
  /** The most a team admin may set (null = no cap, or the viewer is a workspace admin). */
  budgetCap: number | null;
}

export interface TeamBudgetInput {
  maxBudget?: number | null;
  budgetDuration?: string | null;
}

/** `GET /api/usage/teams?days=`: usage of each team's work. */
export interface TeamUsageRow {
  teamId: string;
  name: string;
  tokens: number;
  costUsd: string | null;
  runs: number;
  gatewayBudget: GatewayBudget | null;
}

export interface TeamUsage {
  start: string;
  end: string;
  teams: TeamUsageRow[];
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const gatewayKeysApi = {
  getKeyIssuing: (providerId: string) =>
    request<KeyIssuingSettings>(`/api/model-providers/${providerId}/key-issuing`),

  saveKeyIssuing: (providerId: string, body: SaveKeyIssuing) =>
    request<{
      settings: KeyIssuingSettings;
      adminKeyTest: { ok: boolean; error?: string } | null;
      changed: string[];
    }>(`/api/model-providers/${providerId}/key-issuing`, { method: "PUT", ...json(body) }),

  getMyKey: () => request<MyGatewayKey>("/api/gateway/me/key"),

  /** "Get my token": Optio makes the viewer a key on the gateway and stores it as their token. */
  issueMyKey: () =>
    request<IssuedKeyResult>("/api/gateway/me/key", { method: "POST", ...json({}) }),

  rotateMyKey: () =>
    request<IssuedKeyResult>("/api/gateway/me/key/rotate", { method: "POST", ...json({}) }),

  revokeMyKey: () => request<{ revoked: number }>("/api/gateway/me/key", { method: "DELETE" }),

  getTeamKey: (teamId: string) => request<TeamGatewayKey>(`/api/gateway/teams/${teamId}`),

  /** "Create team key" (or rotate it): the team's key on the gateway, with the budget. */
  createTeamKey: (teamId: string, budget: TeamBudgetInput = {}) =>
    request<IssuedKeyResult & { budget: GatewayBudget }>(`/api/gateway/teams/${teamId}/key`, {
      method: "POST",
      ...json(budget),
    }),

  setTeamBudget: (teamId: string, budget: TeamBudgetInput) =>
    request<{ budget: GatewayBudget }>(`/api/gateway/teams/${teamId}/budget`, {
      method: "PUT",
      ...json(budget),
    }),

  revokeTeamKey: (teamId: string) =>
    request<{ revoked: number }>(`/api/gateway/teams/${teamId}/key`, { method: "DELETE" }),

  getTeamUsage: (days: number) => request<TeamUsage>(`/api/usage/teams?days=${days}`),
};

/**
 * Delete a model provider (Settings → Model gateway / Model providers). When
 * Optio couldn't delete the keys it made on a gateway there, the API
 * answers 409 saying why. The admin is then asked whether to delete it
 * anyway (`?force=true`; the keys stay on the gateway). Answers false when they
 * said no.
 */
export async function deleteModelProviderAsking(
  provider: { id: string; name: string },
  ask: (question: string) => boolean = (q) => window.confirm(q),
): Promise<boolean> {
  try {
    await api.deleteModelProvider(provider.id);
    return true;
  } catch (err) {
    if ((err as { status?: number }).status !== 409) throw err;
    const why = err instanceof Error ? err.message : String(err);
    if (!ask(`${why}\n\nDelete ${provider.name} anyway?`)) return false;
    await request<void>(`/api/model-providers/${provider.id}?force=true`, { method: "DELETE" });
    return true;
  }
}

/** "$4.20 of $10.00 spent · resets 11/1/2026" for a key's or a team's budget. */
export function budgetLine(b: {
  spend: number | null;
  maxBudget: number | null;
  budgetDuration?: string | null;
  budgetResetAt: string | null;
}): string {
  const spent = b.spend === null ? "Spend not read yet" : `$${b.spend.toFixed(2)}`;
  const of = b.maxBudget !== null ? ` of $${b.maxBudget.toFixed(2)}` : "";
  const period = b.maxBudget !== null && b.budgetDuration ? ` per ${b.budgetDuration}` : "";
  const reset = b.budgetResetAt
    ? ` · resets ${new Date(b.budgetResetAt).toLocaleDateString()}`
    : "";
  return `${spent}${of}${period}${b.spend === null ? "" : " spent"}${reset}`;
}

/** The share of a budget spent, 0..1+ (null without a budget or a reading). */
export function budgetShare(b: { spend: number | null; maxBudget: number | null }): number | null {
  if (b.spend === null || b.maxBudget === null || b.maxBudget <= 0) return null;
  return b.spend / b.maxBudget;
}
