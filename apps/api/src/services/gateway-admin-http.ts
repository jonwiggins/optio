import { createHash } from "node:crypto";
import type { ModelGatewayType } from "@optio/shared";
import {
  MAX_GATEWAY_BODY_BYTES,
  describeFailure,
  gatewayFetch,
  readCapped,
} from "./model-gateway-service.js";

/**
 * What every gateway's key-management client shares (services/gateway-keys.ts;
 * docs/model-gateway.md "Keys Optio makes"): where the admin API answers and
 * the key it takes, the error a refusal becomes, the shapes of a key made and
 * a key's spend, and the driver each gateway type implements
 * (litellm-admin.ts, openrouter-admin.ts; gateway-admin.ts picks one). Every
 * call goes through the gateway's own guarded fetch (`gatewayFetch`: the
 * deployment's outbound policy, no redirects, its CA trust), and an answer
 * larger than `MAX_GATEWAY_BODY_BYTES` is not read. Tests swap the fetch with
 * `setGatewayFetchForTests` or point the gateway at an in-process fake
 * (test-utils/fake-*.ts).
 */

/** Where a gateway's management API answers, and the admin key it takes. */
export interface GatewayAdmin {
  /** Absent = `litellm`. */
  type?: ModelGatewayType;
  base: string;
  adminKey: string;
}

/** The gateway answered with an error, or couldn't be reached. `status` is 502 for the latter. */
export class GatewayAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string = message,
  ) {
    super(message);
    this.name = "GatewayAdminError";
  }
}

/** The SHA-256 of a key's value, hex: how Optio recognises a key in a secret (and LiteLLM's id). */
export function keyValueHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** The last four characters, for "…abcd" hints. */
export function keyHint(key: string): string {
  return key.slice(-4);
}

/** A gateway's error text: `{ error: { message } }`, `{ error: "…" }`, `{ detail }`, `{ message }` or a string. */
export function errorText(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  const b = (body ?? {}) as Record<string, unknown>;
  const err = b.error as Record<string, unknown> | string | undefined;
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  const detail = b.detail as Record<string, unknown> | string | undefined;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail.error === "string") return detail.error;
  if (typeof b.message === "string") return b.message;
  return JSON.stringify(body ?? null).slice(0, 300);
}

export type AdminMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One call to a gateway's admin API: the status and the parsed body (a
 * string when it isn't JSON). Throws a `GatewayAdminError` (502) only when
 * the gateway can't be reached.
 */
export async function adminCall(
  url: string,
  method: AdminMethod,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await gatewayFetch()(url, {
      method,
      headers: {
        Accept: "application/json",
        ...headers,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new GatewayAdminError(`Couldn't reach the gateway: ${describeFailure(err)}`, 502);
  }
  let parsed: unknown = null;
  const text = (await readCapped(res, MAX_GATEWAY_BODY_BYTES).catch(() => "")) ?? "";
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** A 2xx answer's body as an object, else a `GatewayAdminError` naming the gateway, route and reason. */
export function okBody(
  res: { status: number; body: unknown },
  what: { gateway: string; route: string },
): Record<string, unknown> {
  if (res.status >= 200 && res.status < 300) {
    return (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, unknown>;
  }
  const reason = errorText(res.body);
  if (res.status === 401 || res.status === 403) {
    throw new GatewayAdminError(
      `The gateway refused the admin key for ${what.route} (${res.status}): ${reason}`,
      res.status,
      reason,
    );
  }
  throw new GatewayAdminError(
    `${what.gateway} ${what.route} answered ${res.status}: ${reason}`,
    res.status,
    reason,
  );
}

// ── What every driver takes and answers ──────────────────────────────────────

export interface GenerateKeyInput {
  keyAlias: string;
  /** LiteLLM's `user_id` (the person's email). */
  userId?: string | null;
  /** LiteLLM: the models the key may call; empty = every model the gateway serves. */
  models: string[];
  maxBudget?: number | null;
  budgetDuration?: string | null;
  /** How long the key lives ("90d"); absent = no expiry. */
  duration?: string | null;
  /**
   * What the key starts having spent (USD): a replaced key's spend this
   * period, so a new key never starts a budget over. LiteLLM sets it as the
   * key's spend; OpenRouter lowers the key's limit by it.
   */
  spend?: number | null;
  metadata?: Record<string, string>;
}

export interface GeneratedKey {
  key: string;
  /** The SHA-256 of the value (LiteLLM's id for it). */
  keyHash: string;
  /** The gateway's own id for the key when it isn't `keyHash` (OpenRouter's hash). */
  keyId?: string | null;
  keyAlias: string;
  expiresAt: Date | null;
}

/** What a gateway says a key has spent, and of what. */
export interface GatewaySpend {
  spend: number;
  maxBudget: number | null;
  budgetResetAt: string | null;
  budgetDuration: string | null;
  blocked: boolean;
}

/**
 * One gateway type's key management, as services/gateway-keys.ts and the
 * housekeeping check use it. A key is named by the gateway's id for it
 * (`keyId`: LiteLLM's hash of the value, OpenRouter's own hash).
 */
export interface GatewayKeyDriver {
  readonly type: ModelGatewayType;
  /** How the gateway is named in messages ("LiteLLM"). */
  readonly label: string;
  /**
   * How a new key carries a replaced key's spend: on its spend (`spend`,
   * LiteLLM) or by a lower limit (`limit`, OpenRouter).
   */
  readonly carry: "spend" | "limit";
  /** Whether the admin key may manage keys. Never throws. */
  check(): Promise<{ ok: boolean; error?: string }>;
  generateKey(input: GenerateKeyInput): Promise<GeneratedKey>;
  /** A new alias for a key (frees an alias the gateway wants unique). */
  renameKey?(keyId: string, alias: string): Promise<void>;
  /** Deleted on the gateway; a key it no longer has counts as deleted. */
  deleteKeys(keyIds: string[]): Promise<void>;
  /** The key stops working: blocked (its spend kept) where the gateway can, else deleted. */
  blockKey(keyId: string): Promise<"blocked" | "deleted">;
  /** What the gateway says the key spent this period and of what (null = it has no such key). */
  keySpend(keyId: string): Promise<GatewaySpend | null>;
  /**
   * Amounts a key carried whose period is over come off it: LiteLLM takes
   * `takeOff` off its spend; OpenRouter sets its limit back to the budget
   * less what is still carried.
   */
  releaseCarried(
    keyId: string,
    due: { takeOff: number; stillCarried: number; maxBudget: number | null },
  ): Promise<void>;
}

/** An ISO time `duration` ("90d") from `from`, with seconds, for gateways that take an expiry time. */
export function expiryFrom(duration: string | null | undefined, from = new Date()): string | null {
  const m = duration?.trim().match(/^(\d+)(s|m|h|d|w|mo)$/);
  if (!m) return null;
  const unit: Record<string, number> = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
    mo: 2592000,
  };
  const at = new Date(from.getTime() + Number(m[1]) * (unit[m[2]] ?? 0) * 1000);
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}
