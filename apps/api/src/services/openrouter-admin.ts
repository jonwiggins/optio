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
  type GatewaySpend,
  type GenerateKeyInput,
  type GeneratedKey,
  type TeamBudgetInput,
} from "./gateway-admin-http.js";

/**
 * OpenRouter's key management, as Optio uses it to make keys for people and
 * teams (services/gateway-keys.ts; docs/model-gateway.md "Gateway types").
 * Every call carries the gateway's management key, at `<base URL>/v1/keys`
 * (`https://openrouter.ai/api/v1/keys`), as OpenRouter's API reference
 * documents it ("API Keys": create, get, update, delete, list):
 *
 * - `POST /keys` `{ name, limit, limit_reset, expires_at }` → 201
 *   `{ data: { hash, … }, key }` (the value only this once);
 * - `GET /keys/{hash}` → `{ data: { usage, usage_daily, usage_weekly,
 *   usage_monthly, limit, limit_remaining, limit_reset, disabled,
 *   expires_at, … } }`;
 * - `PATCH /keys/{hash}` `{ name?, disabled?, limit?, limit_reset? }`;
 * - `DELETE /keys/{hash}` → `{ deleted: true }`, 404 for a key it doesn't have;
 * - `GET /keys` (the admin key's check).
 *
 * A key's limit is USD of credit and resets `daily`, `weekly` (Monday to
 * Sunday) or `monthly`, at midnight UTC. OpenRouter keeps no team whose keys
 * share a budget: a team's key carries the team's budget as its own limit.
 * A replaced key's spend this period carries as a lower limit on the key
 * that replaces it (`carry: "limit"`), until that period ends and the
 * housekeeping check sets the limit back. Checked against the API reference
 * and an in-process fake (test-utils/fake-openrouter.ts), not a live account.
 */

const GATEWAY = "OpenRouter";

type LimitReset = "daily" | "weekly" | "monthly";

function headers(admin: GatewayAdmin): Record<string, string> {
  return { Authorization: `Bearer ${admin.adminKey}` };
}

async function call(admin: GatewayAdmin, method: AdminMethod, path: string, body?: unknown) {
  return adminCall(`${admin.base}${path}`, method, headers(admin), body);
}

async function ok(admin: GatewayAdmin, method: AdminMethod, path: string, body?: unknown) {
  return okBody(await call(admin, method, path, body), {
    gateway: GATEWAY,
    route: path.split("?")[0].replace(/\/keys\/[^/]+$/, "/keys/{hash}"),
  });
}

/** A budget period as OpenRouter's `limit_reset` (null = never resets). */
export function openRouterLimitReset(period: string | null | undefined): LimitReset | null {
  switch (gatewayBudgetPeriodFor("openrouter", period ?? null)) {
    case "1d":
      return "daily";
    case "1w":
      return "weekly";
    case "1mo":
      return "monthly";
    default:
      return null;
  }
}

function periodOf(reset: unknown): string | null {
  return reset === "daily" ? "1d" : reset === "weekly" ? "1w" : reset === "monthly" ? "1mo" : null;
}

/** When a `limit_reset` period running at `now` ends: the next midnight, Monday or 1st, UTC. */
export function openRouterResetAt(reset: unknown, now = new Date()): string | null {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (reset === "daily") return new Date(day + 86_400_000).toISOString();
  if (reset === "weekly") {
    // getUTCDay: Sunday 0 … Saturday 6; weeks run Monday to Sunday.
    const toMonday = ((8 - now.getUTCDay()) % 7 || 7) * 86_400_000;
    return new Date(day + toMonday).toISOString();
  }
  if (reset === "monthly") {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  }
  return null;
}

function money(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * A key object (`data` of `GET /keys/{hash}`, or of `GET /api/v1/key` for
 * the key itself) as what it spent this period and of what: the limit less
 * what remains, else the period's usage.
 */
export function openRouterSpend(data: Record<string, unknown>, now = new Date()): GatewaySpend {
  const reset = data.limit_reset;
  const limit = money(data.limit);
  const remaining = money(data.limit_remaining);
  const usage =
    reset === "daily"
      ? data.usage_daily
      : reset === "weekly"
        ? data.usage_weekly
        : reset === "monthly"
          ? data.usage_monthly
          : data.usage;
  const spend =
    limit !== null && remaining !== null ? Math.max(0, limit - remaining) : (money(usage) ?? 0);
  return {
    spend: Math.round(spend * 1e6) / 1e6,
    maxBudget: limit,
    budgetResetAt: openRouterResetAt(reset, now),
    budgetDuration: periodOf(reset),
    blocked: data.disabled === true,
  };
}

/** The limit a key gets: the budget less what it carries (never below 0); null = no limit. */
function limitOf(maxBudget: number | null | undefined, carried: number): number | null {
  if (maxBudget === null || maxBudget === undefined) return null;
  return Math.max(0, Math.round((maxBudget - Math.max(0, carried)) * 1e6) / 1e6);
}

/** `POST /keys`: a key with its limit, reset and expiry. */
export async function generateOpenRouterKey(
  admin: GatewayAdmin,
  input: GenerateKeyInput,
): Promise<GeneratedKey> {
  const body: Record<string, unknown> = { name: input.keyAlias };
  const limit = limitOf(input.maxBudget, input.spend ?? 0);
  if (limit !== null) {
    body.limit = limit;
    const reset = openRouterLimitReset(input.budgetDuration);
    if (reset) body.limit_reset = reset;
  }
  const expires = expiryFrom(input.duration);
  if (expires) body.expires_at = expires;
  const res = await ok(admin, "POST", "/keys", body);
  const key = typeof res.key === "string" ? res.key : "";
  const data = (res.data ?? {}) as Record<string, unknown>;
  const hash = typeof data.hash === "string" ? data.hash : "";
  if (!key || !hash) {
    throw new GatewayAdminError("OpenRouter /keys answered without a key or its hash", 502);
  }
  const at =
    typeof data.expires_at === "string" && data.expires_at ? new Date(data.expires_at) : null;
  return {
    key,
    keyHash: keyValueHash(key),
    keyId: hash,
    keyAlias: typeof data.name === "string" && data.name ? data.name : input.keyAlias,
    expiresAt: at && !Number.isNaN(at.getTime()) ? at : expires ? new Date(expires) : null,
  };
}

/** `GET /keys/{hash}`: what the key spent this period (null = OpenRouter has no such key). */
export async function openRouterKeySpend(
  admin: GatewayAdmin,
  hash: string,
): Promise<GatewaySpend | null> {
  const res = await call(admin, "GET", `/keys/${encodeURIComponent(hash)}`);
  if (res.status === 404) return null;
  const body = okBody(res, { gateway: GATEWAY, route: "/keys/{hash}" });
  return openRouterSpend((body.data ?? {}) as Record<string, unknown>);
}

/** `PATCH /keys/{hash}`. */
export async function updateOpenRouterKey(
  admin: GatewayAdmin,
  hash: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await ok(admin, "PATCH", `/keys/${encodeURIComponent(hash)}`, patch);
}

/** `DELETE /keys/{hash}` for each; one OpenRouter doesn't have counts as deleted. */
export async function deleteOpenRouterKeys(admin: GatewayAdmin, hashes: string[]): Promise<void> {
  for (const hash of hashes) {
    const res = await call(admin, "DELETE", `/keys/${encodeURIComponent(hash)}`);
    if ((res.status >= 200 && res.status < 300) || res.status === 404) continue;
    okBody(res, { gateway: GATEWAY, route: "/keys/{hash}" });
  }
}

/** Whether the management key may list keys (`GET /keys`). Never throws. */
export async function checkOpenRouterAdminKey(
  admin: GatewayAdmin,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await call(admin, "GET", "/keys?offset=0");
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: `The gateway refused the management key (${res.status}): ${errorText(res.body)}`,
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        error: "The gateway has no /v1/keys: is the base URL OpenRouter's /api?",
      };
    }
    return { ok: false, error: `OpenRouter /keys answered ${res.status}: ${errorText(res.body)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** OpenRouter as a gateway-key driver (gateway-admin.ts). */
export function openRouterDriver(admin: GatewayAdmin): GatewayKeyDriver {
  return {
    type: "openrouter",
    label: GATEWAY,
    carry: "limit",
    teams: false,
    check: () => checkOpenRouterAdminKey(admin),
    generateKey: (input) => generateOpenRouterKey(admin, input),
    deleteKeys: (hashes) => deleteOpenRouterKeys(admin, hashes),
    async blockKey(hash) {
      const res = await call(admin, "PATCH", `/keys/${encodeURIComponent(hash)}`, {
        disabled: true,
      });
      if (res.status === 404) return "deleted";
      okBody(res, { gateway: GATEWAY, route: "/keys/{hash}" });
      return "blocked";
    },
    keySpend: (hash) => openRouterKeySpend(admin, hash),
    setKeyBudget: (hash, budget: TeamBudgetInput, carried: number) =>
      updateOpenRouterKey(admin, hash, {
        limit: limitOf(budget.maxBudget, carried),
        limit_reset: budget.maxBudget === null ? null : openRouterLimitReset(budget.budgetDuration),
      }),
    async releaseCarried(hash, due) {
      if (due.maxBudget === null) return;
      await updateOpenRouterKey(admin, hash, { limit: limitOf(due.maxBudget, due.stillCarried) });
    },
  };
}
