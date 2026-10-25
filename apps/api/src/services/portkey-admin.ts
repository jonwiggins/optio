import { gatewayBudgetPeriodFor } from "@optio/shared";
import {
  GatewayAdminError,
  adminCall,
  errorText,
  expiryFrom,
  keyValueHash,
  okBody,
  type AdminMethod,
  type GatewayAdmin,
  type GatewayKeyDriver,
  type GenerateKeyInput,
  type GeneratedKey,
  type TeamBudgetInput,
} from "./gateway-admin-http.js";

/**
 * Portkey's key management, as Optio uses it to make keys for people and
 * teams (services/gateway-keys.ts; docs/model-gateway.md "Gateway types").
 * Every call carries the admin API key as `x-portkey-api-key`, at the
 * control plane (`https://api.portkey.ai/v1`, or a self-hosted control
 * plane's URL), as Portkey's Admin API reference documents it ("API Keys"):
 *
 * - `POST /api-keys/workspace/service` `{ name, scopes, workspace_id?,
 *   usage_limits: { type: "cost", credit_limit, periodic_reset |
 *   periodic_reset_days }, expires_at, defaults: { metadata } }` →
 *   `{ id, key, object: "api-key" }`;
 * - `POST /api-keys/{id}/rotate` `{ key_transition_period_ms }` →
 *   `{ id, key, key_transition_expires_at }`: a new value for the same key,
 *   its limits and usage kept, the old value accepted until then;
 * - `PUT /api-keys/{id}` `{ usage_limits }`;
 * - `DELETE /api-keys/{id}`;
 * - `GET /api-keys` (the admin key's check).
 *
 * A key's cost limit is whole USD (1 or more) and resets weekly, monthly or
 * every so many days. The key API doesn't report what a key has spent, so
 * Optio sends no budget warnings for Portkey keys (Portkey's own alerts can),
 * and a key is rotated in place rather than replaced, so its usage stays
 * with it. Portkey documents no way to disable a key, so blocking one
 * deletes it. Checked against the API reference and an in-process fake
 * (test-utils/fake-portkey.ts), not a live account.
 */

const GATEWAY = "Portkey";

/** The scope a key Optio makes needs to call models (and list them). */
export const PORTKEY_KEY_SCOPES = ["completions.write"];

/** How long a rotated key's old value is still accepted: Portkey's minimum, 30 minutes. */
export const PORTKEY_ROTATION_GRACE_MS = 1_800_000;

function headers(admin: GatewayAdmin): Record<string, string> {
  return { "x-portkey-api-key": admin.adminKey };
}

async function call(admin: GatewayAdmin, method: AdminMethod, path: string, body?: unknown) {
  return adminCall(`${admin.base}${path}`, method, headers(admin), body);
}

function route(path: string): string {
  return path
    .split("?")[0]
    .replace(/\/api-keys\/[0-9a-f-]{36}(\/rotate)?$/i, (_, r) => `/api-keys/{id}${r ?? ""}`);
}

async function ok(admin: GatewayAdmin, method: AdminMethod, path: string, body?: unknown) {
  return okBody(await call(admin, method, path, body), { gateway: GATEWAY, route: route(path) });
}

/** A budget as Portkey's `usage_limits` (null = no cap). */
export function portkeyUsageLimits(
  maxBudget: number | null | undefined,
  period: string | null | undefined,
): Record<string, unknown> | null {
  if (maxBudget === null || maxBudget === undefined) return null;
  const limits: Record<string, unknown> = {
    type: "cost",
    credit_limit: Math.max(1, Math.ceil(maxBudget)),
  };
  const p = gatewayBudgetPeriodFor("portkey", period ?? null);
  if (p === "1w") limits.periodic_reset = "weekly";
  else if (p === "1mo") limits.periodic_reset = "monthly";
  else if (p) limits.periodic_reset_days = Number(p.replace(/d$/, ""));
  return limits;
}

/** `POST /api-keys/workspace/service`: a key with its cost limit, expiry and metadata. */
export async function generatePortkeyKey(
  admin: GatewayAdmin,
  input: GenerateKeyInput,
): Promise<GeneratedKey> {
  const metadata: Record<string, string> = { ...(input.metadata ?? {}) };
  // Portkey's own field for whose requests these are (its analytics' "User").
  if (input.userId) metadata._user = input.userId;
  const body: Record<string, unknown> = {
    name: input.keyAlias,
    description: "Made by Optio",
    scopes: PORTKEY_KEY_SCOPES,
    defaults: { metadata },
  };
  if (admin.workspace) body.workspace_id = admin.workspace;
  const limits = portkeyUsageLimits(input.maxBudget, input.budgetDuration);
  if (limits) body.usage_limits = limits;
  const expires = expiryFrom(input.duration);
  if (expires) body.expires_at = expires;
  const res = await ok(admin, "POST", "/api-keys/workspace/service", body);
  const key = typeof res.key === "string" ? res.key : "";
  const id = typeof res.id === "string" ? res.id : "";
  if (!key || !id) {
    throw new GatewayAdminError("Portkey /api-keys answered without a key or its id", 502);
  }
  return {
    key,
    keyHash: keyValueHash(key),
    keyId: id,
    keyAlias: input.keyAlias,
    expiresAt: expires ? new Date(expires) : null,
  };
}

/** `POST /api-keys/{id}/rotate`: a new value for the key; the old one lapses after the grace. */
export async function rotatePortkeyKey(
  admin: GatewayAdmin,
  id: string,
  keyAlias: string,
): Promise<GeneratedKey> {
  const res = await ok(admin, "POST", `/api-keys/${encodeURIComponent(id)}/rotate`, {
    key_transition_period_ms: PORTKEY_ROTATION_GRACE_MS,
  });
  const key = typeof res.key === "string" ? res.key : "";
  if (!key)
    throw new GatewayAdminError("Portkey /api-keys/{id}/rotate answered without a key", 502);
  return {
    key,
    keyHash: keyValueHash(key),
    keyId: typeof res.id === "string" && res.id ? res.id : id,
    keyAlias,
    expiresAt: null,
  };
}

/** `DELETE /api-keys/{id}` for each; one Portkey doesn't have counts as deleted. */
export async function deletePortkeyKeys(admin: GatewayAdmin, ids: string[]): Promise<void> {
  for (const id of ids) {
    const res = await call(admin, "DELETE", `/api-keys/${encodeURIComponent(id)}`);
    if ((res.status >= 200 && res.status < 300) || res.status === 404) continue;
    okBody(res, { gateway: GATEWAY, route: "/api-keys/{id}" });
  }
}

/** `PUT /api-keys/{id}` with a new cost limit. Portkey documents no way to take one off. */
export async function setPortkeyKeyBudget(
  admin: GatewayAdmin,
  id: string,
  budget: TeamBudgetInput,
): Promise<void> {
  const limits = portkeyUsageLimits(budget.maxBudget, budget.budgetDuration);
  if (!limits) {
    throw new GatewayAdminError(
      "Portkey can't take a key's budget off: set another amount, or revoke the key and make a new one",
      400,
    );
  }
  await ok(admin, "PUT", `/api-keys/${encodeURIComponent(id)}`, { usage_limits: limits });
}

/** Whether the admin key may list keys (`GET /api-keys`). Never throws. */
export async function checkPortkeyAdminKey(
  admin: GatewayAdmin,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const query = admin.workspace
      ? `?page_size=1&workspace_id=${encodeURIComponent(admin.workspace)}`
      : "?page_size=1";
    const res = await call(admin, "GET", `/api-keys${query}`);
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: `The gateway refused the admin key (${res.status}): ${errorText(res.body)}`,
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        error: "The gateway has no /api-keys: is the control plane URL Portkey's admin API?",
      };
    }
    return { ok: false, error: `Portkey /api-keys answered ${res.status}: ${errorText(res.body)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Portkey as a gateway-key driver (gateway-admin.ts). */
export function portkeyDriver(admin: GatewayAdmin): GatewayKeyDriver {
  return {
    type: "portkey",
    label: GATEWAY,
    carry: null,
    teams: false,
    check: () => checkPortkeyAdminKey(admin),
    generateKey: (input) => generatePortkeyKey(admin, input),
    rotateKey: (id, alias) => rotatePortkeyKey(admin, id, alias ?? ""),
    deleteKeys: (ids) => deletePortkeyKeys(admin, ids),
    async blockKey(id) {
      await deletePortkeyKeys(admin, [id]);
      return "deleted";
    },
    // Portkey's key API doesn't report a key's usage.
    keySpend: async () => null,
    setKeyBudget: (id, budget) => setPortkeyKeyBudget(admin, id, budget),
    releaseCarried: async () => {},
  };
}
