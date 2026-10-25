import { describeFailure, gatewayFetch } from "./model-gateway-service.js";
import {
  GatewayAdminError,
  keyHint,
  keyValueHash,
  type GatewayAdmin,
  type GatewayKeyDriver,
  type GatewaySpend,
  type GenerateKeyInput,
  type GeneratedKey,
  type TeamBudgetInput,
} from "./gateway-admin-http.js";

export { keyHint };
export type { GenerateKeyInput, GeneratedKey, TeamBudgetInput };

/**
 * LiteLLM's key-management API, as Optio uses it to make keys for people
 * and teams (services/gateway-keys.ts; docs/model-gateway.md "Keys Optio
 * makes"). Every call carries the gateway's admin key (the master key, or
 * a proxy-admin user's key) and goes through the gateway's own fetch, so it
 * trusts the site CA the same way (`NODE_EXTRA_CA_CERTS`,
 * `OPTIO_GATEWAY_CA_PEM`). Tests point it at an in-process fake
 * (`test-utils/fake-litellm.ts`) or swap the fetch with
 * `setGatewayFetchForTests`.
 *
 * LiteLLM names a key by the SHA-256 of its value (`hash_token`), and every
 * route below takes that id where it takes a key, so Optio never needs the
 * value again once it is stored.
 */

/** Where LiteLLM's management API answers, and the admin key it takes. */
export type LiteLLMAdmin = GatewayAdmin;

/** LiteLLM answered with an error, or couldn't be reached. `status` is 502 for the latter. */
export class LiteLLMError extends GatewayAdminError {
  constructor(message: string, status: number, detail: string = message) {
    super(message, status, detail);
    this.name = "LiteLLMError";
  }
}

/** LiteLLM's id for a key: the SHA-256 of its value, hex. */
export function liteLLMKeyHash(key: string): string {
  return keyValueHash(key);
}

/** LiteLLM's error text: `{ error: { message } }`, `{ detail }` or a string. */
function errorText(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  const b = (body ?? {}) as Record<string, unknown>;
  const err = b.error as Record<string, unknown> | string | undefined;
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  const detail = b.detail as Record<string, unknown> | string | undefined;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail.error === "string") return detail.error;
  return JSON.stringify(body ?? null).slice(0, 300);
}

async function call(
  admin: LiteLLMAdmin,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await gatewayFetch()(`${admin.base}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${admin.adminKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new LiteLLMError(`Couldn't reach the gateway: ${describeFailure(err)}`, 502);
  }
  let parsed: unknown = null;
  const text = await res.text().catch(() => "");
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** A 2xx answer's body, else a `LiteLLMError` naming the route and LiteLLM's reason. */
async function ok(
  admin: LiteLLMAdmin,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await call(admin, method, path, body);
  if (res.status >= 200 && res.status < 300) {
    return (res.body && typeof res.body === "object" ? res.body : {}) as Record<string, unknown>;
  }
  const route = path.split("?")[0];
  const reason = errorText(res.body);
  if (res.status === 401 || res.status === 403) {
    throw new LiteLLMError(
      `The gateway refused the admin key for ${route} (${res.status}): ${reason}`,
      res.status,
      reason,
    );
  }
  throw new LiteLLMError(`LiteLLM ${route} answered ${res.status}: ${reason}`, res.status, reason);
}

/** Whether a refusal was about the key alias being taken. */
export function isAliasTaken(err: unknown): boolean {
  return (
    err instanceof LiteLLMError &&
    err.status >= 400 &&
    err.status < 500 &&
    /alias/i.test(err.detail) &&
    /exist|unique|taken|already/i.test(err.detail)
  );
}

/**
 * Whether a refusal was about a LiteLLM team that doesn't exist (someone
 * removed it in LiteLLM): `/key/generate` or `/team/update` with its id.
 */
export function isTeamMissing(err: unknown): boolean {
  return (
    err instanceof LiteLLMError &&
    (err.status === 400 || err.status === 404) &&
    /team/i.test(err.detail) &&
    /not\s+found|n[o']t\s+exist/i.test(err.detail)
  );
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** `POST /key/generate`. */
export async function generateKey(
  admin: LiteLLMAdmin,
  input: GenerateKeyInput,
): Promise<GeneratedKey> {
  const body: Record<string, unknown> = { key_alias: input.keyAlias, models: input.models };
  if (input.userId) body.user_id = input.userId;
  if (input.teamId) body.team_id = input.teamId;
  if (input.maxBudget !== undefined && input.maxBudget !== null) body.max_budget = input.maxBudget;
  if (input.budgetDuration) body.budget_duration = input.budgetDuration;
  if (input.duration) body.duration = input.duration;
  if (input.spend && input.spend > 0) body.spend = input.spend;
  if (input.metadata) body.metadata = input.metadata;
  const res = await ok(admin, "POST", "/key/generate", body);
  const key = typeof res.key === "string" ? res.key : "";
  if (!key) throw new LiteLLMError("LiteLLM /key/generate answered without a key", 502);
  // LiteLLM's own id when it says (token_id / token), else the same hash computed here.
  const named = [res.token_id, res.token].find(
    (v): v is string => typeof v === "string" && /^[0-9a-f]{64}$/i.test(v),
  );
  const expires = typeof res.expires === "string" && res.expires ? new Date(res.expires) : null;
  return {
    key,
    keyHash: named ?? liteLLMKeyHash(key),
    keyAlias: typeof res.key_alias === "string" ? res.key_alias : input.keyAlias,
    expiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
  };
}

/** `POST /key/delete`; a key LiteLLM no longer has counts as deleted. */
export async function deleteKeys(admin: LiteLLMAdmin, keyHashes: string[]): Promise<void> {
  if (keyHashes.length === 0) return;
  const res = await call(admin, "POST", "/key/delete", { keys: keyHashes });
  if ((res.status >= 200 && res.status < 300) || res.status === 404) return;
  // LiteLLM answers 400 for keys it can't find in some versions.
  if (res.status === 400 && /not found|exist/i.test(errorText(res.body))) return;
  throw new LiteLLMError(
    `LiteLLM /key/delete answered ${res.status}: ${errorText(res.body)}`,
    res.status,
  );
}

/**
 * `POST /key/block`: the key stops working, its spend stays in LiteLLM.
 * A LiteLLM without the route (404) gets `/key/delete` instead.
 */
export async function blockKey(
  admin: LiteLLMAdmin,
  keyHash: string,
): Promise<"blocked" | "deleted"> {
  const res = await call(admin, "POST", "/key/block", { key: keyHash });
  if (res.status >= 200 && res.status < 300) return "blocked";
  if (res.status === 404 || res.status === 405) {
    await deleteKeys(admin, [keyHash]);
    return "deleted";
  }
  throw new LiteLLMError(
    `LiteLLM /key/block answered ${res.status}: ${errorText(res.body)}`,
    res.status,
  );
}

/** `POST /key/update` with a new alias (frees `optio-<user>` for the key that replaces it). */
export async function renameKey(admin: LiteLLMAdmin, keyHash: string, keyAlias: string) {
  await ok(admin, "POST", "/key/update", { key: keyHash, key_alias: keyAlias });
}

/**
 * `POST /key/update` with a new `spend` (USD): the housekeeping check takes
 * an amount a key carried off once its period is over (gateway-key-carry.ts).
 */
export async function setKeySpend(admin: LiteLLMAdmin, keyHash: string, spend: number) {
  await ok(admin, "POST", "/key/update", { key: keyHash, spend: Math.max(0, spend) });
}

/** What LiteLLM says a key or a team has spent, and of what. */
export type LiteLLMSpend = GatewaySpend;

function spendOf(info: Record<string, unknown> | null | undefined): LiteLLMSpend | null {
  if (!info || typeof info !== "object") return null;
  const spend = Number(info.spend ?? 0);
  const max =
    info.max_budget === null || info.max_budget === undefined ? null : Number(info.max_budget);
  const reset = info.budget_reset_at;
  return {
    spend: Number.isFinite(spend) ? spend : 0,
    maxBudget: max !== null && Number.isFinite(max) ? max : null,
    budgetResetAt: typeof reset === "string" && reset ? reset : null,
    budgetDuration: typeof info.budget_duration === "string" ? info.budget_duration : null,
    blocked: info.blocked === true,
  };
}

/** `GET /key/info?key=<id>` as the admin: the key's spend and budget (null = not found). */
export async function keySpend(admin: LiteLLMAdmin, keyHash: string): Promise<LiteLLMSpend | null> {
  const res = await call(admin, "GET", `/key/info?key=${encodeURIComponent(keyHash)}`);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    throw new LiteLLMError(
      `LiteLLM /key/info answered ${res.status}: ${errorText(res.body)}`,
      res.status,
    );
  }
  return spendOf((res.body as { info?: Record<string, unknown> } | null)?.info);
}

// ── Teams ────────────────────────────────────────────────────────────────────

/** `POST /team/new`: a LiteLLM team whose budget its keys share. */
export async function newTeam(
  admin: LiteLLMAdmin,
  input: TeamBudgetInput & { alias: string; models: string[]; metadata?: Record<string, string> },
): Promise<string> {
  const body: Record<string, unknown> = { team_alias: input.alias, models: input.models };
  if (input.maxBudget !== null) body.max_budget = input.maxBudget;
  if (input.budgetDuration) body.budget_duration = input.budgetDuration;
  if (input.metadata) body.metadata = input.metadata;
  const res = await ok(admin, "POST", "/team/new", body);
  const teamId = typeof res.team_id === "string" ? res.team_id : "";
  if (!teamId) throw new LiteLLMError("LiteLLM /team/new answered without a team_id", 502);
  return teamId;
}

/** `POST /team/update`: the team's budget. */
export async function updateTeamBudget(
  admin: LiteLLMAdmin,
  teamId: string,
  input: TeamBudgetInput,
): Promise<void> {
  await ok(admin, "POST", "/team/update", {
    team_id: teamId,
    max_budget: input.maxBudget,
    ...(input.budgetDuration ? { budget_duration: input.budgetDuration } : {}),
  });
}

/** `GET /team/info?team_id=`: the team's spend and budget (null = not found). */
export async function teamSpend(admin: LiteLLMAdmin, teamId: string): Promise<LiteLLMSpend | null> {
  const res = await call(admin, "GET", `/team/info?team_id=${encodeURIComponent(teamId)}`);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    throw new LiteLLMError(
      `LiteLLM /team/info answered ${res.status}: ${errorText(res.body)}`,
      res.status,
    );
  }
  const body = (res.body ?? {}) as Record<string, unknown>;
  return spendOf((body.team_info as Record<string, unknown> | undefined) ?? body);
}

// ── The admin key ────────────────────────────────────────────────────────────

/**
 * Whether the admin key may manage keys: `GET /key/list` (admins only in
 * LiteLLM). Never throws.
 */
export async function checkAdminKey(admin: LiteLLMAdmin): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await call(admin, "GET", "/key/list?page=1&size=1");
    if (res.status >= 200 && res.status < 300) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: `The gateway refused the admin key (${res.status}): ${errorText(res.body)}`,
      };
    }
    if (res.status === 404) {
      return { ok: false, error: "The gateway has no /key/list: is it LiteLLM?" };
    }
    return { ok: false, error: `LiteLLM /key/list answered ${res.status}: ${errorText(res.body)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── The driver (gateway-admin.ts) ────────────────────────────────────────────

/**
 * LiteLLM as a gateway-key driver: keys named by their hash, aliases kept
 * unique, a replaced key's spend carried as the new key's spend, and teams
 * whose keys share one budget.
 */
export function liteLLMDriver(admin: LiteLLMAdmin): GatewayKeyDriver {
  return {
    type: "litellm",
    label: "LiteLLM",
    carry: "spend",
    teams: true,
    check: () => checkAdminKey(admin),
    generateKey: (input) => generateKey(admin, input),
    renameKey: (keyId, alias) => renameKey(admin, keyId, alias),
    deleteKeys: (keyIds) => deleteKeys(admin, keyIds),
    blockKey: (keyId) => blockKey(admin, keyId),
    keySpend: (keyId) => keySpend(admin, keyId),
    async releaseCarried(keyId, due) {
      if (due.takeOff <= 0) return;
      const live = await keySpend(admin, keyId);
      // null: LiteLLM no longer has the key, so there is nothing to take off.
      if (live) await setKeySpend(admin, keyId, live.spend - due.takeOff);
    },
    newTeam: (input) => newTeam(admin, input),
    updateTeamBudget: (teamId, input) => updateTeamBudget(admin, teamId, input),
    teamSpend: (teamId) => teamSpend(admin, teamId),
  };
}
