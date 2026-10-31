import { z } from "zod";
import { gatewayBudgetPeriodFor } from "@optio/shared";
import { openRouterKeySchema, openRouterSpend } from "./openrouter-key.js";
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
} from "./gateway-admin-http.js";

/**
 * OpenRouter's key management, as Optio uses it to make keys for people
 * (services/gateway-keys.ts; docs/model-gateway.md "Keys Optio makes").
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
 * Sunday) or `monthly`, at midnight UTC. Every answer is zod-checked. A
 * replaced key's spend this period carries as a lower limit on the key
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

/** The limit a key gets: the budget less what it carries (never below 0); null = no limit. */
function limitOf(maxBudget: number | null | undefined, carried: number): number | null {
  if (maxBudget === null || maxBudget === undefined) return null;
  return Math.max(0, Math.round((maxBudget - Math.max(0, carried)) * 1e6) / 1e6);
}

/** `POST /keys`'s answer: the key's value (this once) and its hash. */
const createdKeySchema = z.object({
  key: z.string().min(8).max(4096),
  data: z
    .object({
      hash: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/),
      name: z.string().max(200).nullish(),
      expires_at: z.string().max(64).nullish(),
    })
    .passthrough(),
});

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
  const res = createdKeySchema.safeParse(await ok(admin, "POST", "/keys", body));
  if (!res.success) {
    throw new GatewayAdminError("OpenRouter /keys answered without a key or its hash", 502);
  }
  const { key, data } = res.data;
  const at = data.expires_at ? new Date(data.expires_at) : null;
  return {
    key,
    keyHash: keyValueHash(key),
    keyId: data.hash,
    keyAlias: data.name || input.keyAlias,
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
  const body = z
    .object({ data: openRouterKeySchema })
    .safeParse(okBody(res, { gateway: GATEWAY, route: "/keys/{hash}" }));
  if (!body.success) {
    throw new GatewayAdminError("OpenRouter /keys/{hash} answered in another shape", 502);
  }
  return openRouterSpend(body.data.data);
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
    async releaseCarried(hash, due) {
      if (due.maxBudget === null) return;
      await updateOpenRouterKey(admin, hash, { limit: limitOf(due.maxBudget, due.stillCarried) });
    },
  };
}
