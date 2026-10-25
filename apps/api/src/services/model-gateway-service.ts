import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { Agent, fetch as undiciFetch } from "undici";
import {
  gatewayModelPick,
  gatewayTokenSecretName,
  isModelProviderAgent,
  modelGatewayCapabilities,
  modelGatewayTypeInfo,
  modelGatewayTypeOf,
  normalizeGatewayBaseUrl,
  type ModelGatewayType,
  type ModelProviderAgent,
  type ModelProviderModel,
} from "@optio/shared";
import { db } from "../db/client.js";
import { modelProviders, teams, workspaces } from "../db/schema.js";
import {
  ModelProviderError,
  cleanModels,
  gatewayOf,
  getModelProviderRow,
  storedGatewayToken,
  toModelProvider,
  type ModelProviderRow,
  type ProviderViewer,
} from "./model-provider-service.js";
import { retrieveSecret, storeSecret } from "./secret-service.js";
import { openRouterSpend } from "./openrouter-admin.js";

/**
 * The model gateway (docs/model-gateway.md): the token a run gets, the
 * catalog sync from the gateway (per its type: LiteLLM, OpenRouter, Portkey
 * or any OpenAI- / Anthropic-compatible endpoint), the connection test, the
 * viewer's budget, and a workspace's default gateway.
 *
 * Tokens: a run gets exactly one — personal work its owner's, a team's work
 * the team's, the organization's work the organization's (the secret named
 * by the gateway's auth header, at user / team / global scope). There is no
 * fallback to someone else's key: a missing token fails with a message that
 * says where to add it, so the gateway's spend ledger stays per person.
 */

/** A gateway token is missing for the work's owner; `message` says where to add it. */
export class GatewayTokenMissingError extends ModelProviderError {
  constructor(
    message: string,
    readonly scope: "user" | "team" | "global",
  ) {
    super(message, 400);
    this.name = "GatewayTokenMissingError";
  }
}

export interface GatewayTokenUse {
  provider: ModelProviderRow;
  workspaceId: string | null | undefined;
  /** The work's owner (null = the organization's). */
  ownerUserId: string | null | undefined;
  /** The work's team, when it is a team's. */
  ownerTeamId?: string | null;
}

/** The name of the secret that holds a token for this gateway. */
export function tokenSecretNameOf(row: Pick<ModelProviderRow, "authHeader" | "agents">): string {
  return gatewayTokenSecretName({ authHeader: row.authHeader, agents: row.agents });
}

async function teamName(teamId: string): Promise<string> {
  const [row] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
  return row?.name ?? "the team";
}

/**
 * The token a run of `provider` gets: the sealed one for a `stored` gateway;
 * otherwise the work owner's own — the team's secret for a team's work, the
 * person's for personal work, the organization's (global) for the
 * organization's. Throws `GatewayTokenMissingError` when it isn't there.
 */
export async function resolveGatewayToken(use: GatewayTokenUse): Promise<string> {
  const { provider } = use;
  if (provider.kind !== "gateway") {
    throw new ModelProviderError(`"${provider.name}" isn't a model gateway`);
  }
  if (provider.tokenSource === "stored") {
    const token = storedGatewayToken(provider);
    if (!token) throw new ModelProviderError(`"${provider.name}" has no shared token stored`);
    return token;
  }
  const name = tokenSecretNameOf(provider);
  if (use.ownerTeamId) {
    try {
      return await retrieveSecret(name, "team", use.workspaceId, undefined, use.ownerTeamId);
    } catch {
      throw new GatewayTokenMissingError(
        `This team has no gateway token yet — a team admin adds one under Teams → ${await teamName(use.ownerTeamId)} → Tokens`,
        "team",
      );
    }
  }
  if (use.ownerUserId) {
    try {
      return await retrieveSecret(name, "user", undefined, use.ownerUserId);
    } catch {
      throw new GatewayTokenMissingError(
        "Add your gateway token under Settings → My tokens",
        "user",
      );
    }
  }
  try {
    return await retrieveSecret(name, "global");
  } catch {
    throw new GatewayTokenMissingError(
      "The organization has no gateway token — an admin adds one under Settings → Model gateway",
      "global",
    );
  }
}

/** The organization's token for the gateway, or null. */
export async function organizationGatewayToken(row: ModelProviderRow): Promise<string | null> {
  return retrieveSecret(tokenSecretNameOf(row), "global").catch(() => null);
}

/** A person's own token for the gateway, or null. */
export async function personalGatewayToken(
  row: ModelProviderRow,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  return retrieveSecret(tokenSecretNameOf(row), "user", undefined, userId).catch(() => null);
}

// ── HTTP to the gateway ──────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;

type GatewayFetch = (url: string, init?: RequestInit) => Promise<Response>;

let fetchOverride: GatewayFetch | null = null;

/** Tests: route the gateway's HTTP through a stand-in (null restores undici). */
export function setGatewayFetchForTests(fetchImpl: GatewayFetch | null): void {
  fetchOverride = fetchImpl;
}

/**
 * An undici fetch bound to the deployment's TLS trust — the same pattern as
 * `oidcFetch`. Node adds `NODE_EXTRA_CA_CERTS` (the chart mounts its
 * `caBundle` there) to its roots; `OPTIO_GATEWAY_CA_PEM` names a CA for
 * the gateway alone, and `OPTIO_GATEWAY_INSECURE_SKIP_VERIFY=true` is for a
 * lab with no CA at all.
 */
export function gatewayFetch(): GatewayFetch {
  if (fetchOverride) return fetchOverride;
  const connect: Record<string, unknown> = { timeout: REQUEST_TIMEOUT_MS };
  const ca = process.env.OPTIO_GATEWAY_CA_PEM?.trim();
  if (ca) connect.ca = ca;
  if (process.env.OPTIO_GATEWAY_INSECURE_SKIP_VERIFY === "true") connect.rejectUnauthorized = false;
  const agent = new Agent({ connect: connect as Agent.Options["connect"] });
  return (url, init) =>
    undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }) as unknown as Promise<Response>;
}

/**
 * Pagination of an Anthropic-style `/v1/models` (`has_more`, `last_id`);
 * an OpenAI-style one answers in one page. The version header is the one
 * Anthropic's API asks for; other gateways ignore it.
 */
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_MODEL_PAGES = 10;

function authHeaders(
  row: Pick<ModelProviderRow, "authHeader"> & { gatewayType?: ModelProviderRow["gatewayType"] },
  token: string,
): HeadersInit {
  const type = modelGatewayTypeOf(row.gatewayType);
  // Portkey takes its own key in its own header.
  if (type === "portkey") return { "x-portkey-api-key": token };
  // LiteLLM's management routes (/model/info, /key/info) take a bearer token
  // whatever the gateway expects from Claude Code; /v1/models takes either.
  const headers: Record<string, string> =
    row.authHeader === "api-key"
      ? { "x-api-key": token, Authorization: `Bearer ${token}` }
      : { Authorization: `Bearer ${token}` };
  if (type === "generic") headers["anthropic-version"] = ANTHROPIC_VERSION;
  return headers;
}

async function getJson(
  url: string,
  headers: HeadersInit,
): Promise<{ status: number; body: unknown }> {
  const res = await gatewayFetch()(url, {
    method: "GET",
    headers: { Accept: "application/json", ...headers },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export function describeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  if (
    cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    cause?.code === "SELF_SIGNED_CERT_IN_CHAIN"
  ) {
    return `${message} — the gateway uses a certificate this deployment doesn't trust (set OPTIO_GATEWAY_CA_PEM or mount it as NODE_EXTRA_CA_CERTS)`;
  }
  return cause?.message ? `${message} (${cause.message})` : message;
}

// ── Catalog sync ─────────────────────────────────────────────────────────────

/** What LiteLLM's `/model/info` says about one model, in catalog terms. */
export interface LiveGatewayModel {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  prices?: NonNullable<ModelProviderModel["prices"]>;
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function perMillion(perToken: unknown): number | undefined {
  const n = typeof perToken === "number" ? perToken : Number(perToken);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * LiteLLM `GET /model/info` → `{ data: [{ model_name, model_info: {
 * max_input_tokens, max_output_tokens, input_cost_per_token, … } }] }`:
 * `model_name` → `id`, the token limits, and per-token costs × 1e6 → USD per
 * million tokens. Models with the same name (a deployment group) merge.
 */
export function parseModelInfo(body: unknown): LiveGatewayModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const byId = new Map<string, LiveGatewayModel>();
  for (const entry of data) {
    const e = entry as {
      model_name?: unknown;
      model_info?: Record<string, unknown> | null;
    };
    const id = typeof e.model_name === "string" ? e.model_name.trim() : "";
    if (!id) continue;
    const info = e.model_info ?? {};
    const model: LiveGatewayModel = byId.get(id) ?? { id };
    model.contextWindow ??= positiveInt(info.max_input_tokens);
    model.maxOutputTokens ??= positiveInt(info.max_output_tokens);
    const prices: NonNullable<ModelProviderModel["prices"]> = { ...(model.prices ?? {}) };
    const input = perMillion(info.input_cost_per_token);
    const output = perMillion(info.output_cost_per_token);
    const cacheRead = perMillion(info.cache_read_input_token_cost);
    const cacheWrite = perMillion(info.cache_creation_input_token_cost);
    if (input !== undefined) prices.input ??= input;
    if (output !== undefined) prices.output ??= output;
    if (cacheRead !== undefined) prices.cacheRead ??= cacheRead;
    if (cacheWrite !== undefined) prices.cacheWrite ??= cacheWrite;
    if (Object.keys(prices).length > 0) model.prices = prices;
    byId.set(id, model);
  }
  return [...byId.values()];
}

/** OpenAI-style `GET /v1/models` → the ids. */
export function parseModelList(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((m) => {
    const id = (m as { id?: unknown })?.id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}

/**
 * OpenRouter `GET /api/v1/models` → `{ data: [{ id, context_length,
 * top_provider: { context_length, max_completion_tokens }, pricing: {
 * prompt, completion, input_cache_read, input_cache_write } }] }`: prices
 * are USD per token as strings (× 1e6 → per million; a negative one, as
 * for a router whose price varies, is left out).
 */
export function parseOpenRouterModels(body: unknown): LiveGatewayModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (!id) return [];
    const top = (e.top_provider ?? {}) as Record<string, unknown>;
    const pricing = (e.pricing ?? {}) as Record<string, unknown>;
    const model: LiveGatewayModel = { id };
    const context = positiveInt(e.context_length) ?? positiveInt(top.context_length);
    if (context) model.contextWindow = context;
    const output = positiveInt(top.max_completion_tokens);
    if (output) model.maxOutputTokens = output;
    const prices: NonNullable<ModelProviderModel["prices"]> = {};
    const input = perMillion(pricing.prompt);
    const out = perMillion(pricing.completion);
    const cacheRead = perMillion(pricing.input_cache_read);
    const cacheWrite = perMillion(pricing.input_cache_write);
    if (input !== undefined) prices.input = input;
    if (out !== undefined) prices.output = out;
    if (cacheRead !== undefined) prices.cacheRead = cacheRead;
    if (cacheWrite !== undefined) prices.cacheWrite = cacheWrite;
    if (Object.keys(prices).length > 0) model.prices = prices;
    return [model];
  });
}

/** The most models a sync adds to one agent's catalog on a gateway other than LiteLLM. */
export const MAX_SYNCED_MODELS = 50;

/**
 * The catalog after a sync: what the gateway reports overwrites the numbers
 * (limits, prices) of models the admin already listed and keeps their names,
 * efforts and roles; new ids are appended (a Claude model gets the five
 * efforts); models the gateway stopped serving stay, flagged `missing`.
 */
export function mergeGatewayCatalog(
  existing: ModelProviderModel[],
  live: LiveGatewayModel[],
  served: string[] = live.map((m) => m.id),
  /**
   * `addNew: false` refreshes only the models already listed (a gateway
   * that lists hundreds); `maxModels` caps what new ids may fill up to.
   */
  opts: { addNew?: boolean; maxModels?: number } = {},
): ModelProviderModel[] {
  const liveById = new Map(live.map((m) => [m.id, m]));
  const servedIds = new Set([...served, ...liveById.keys()]);
  const out: ModelProviderModel[] = [];
  for (const m of existing) {
    const fresh = liveById.get(m.id);
    const next: ModelProviderModel = { ...m };
    if (fresh) {
      if (fresh.contextWindow) next.contextWindow = fresh.contextWindow;
      if (fresh.maxOutputTokens) next.maxOutputTokens = fresh.maxOutputTokens;
      if (fresh.prices) next.prices = { ...(m.prices ?? {}), ...fresh.prices };
    }
    if (servedIds.has(m.id)) delete next.missing;
    else next.missing = true;
    out.push(next);
  }
  if (opts.addNew === false) return out;
  const known = new Set(existing.map((m) => m.id));
  for (const id of servedIds) {
    if (known.has(id)) continue;
    if (opts.maxModels !== undefined && out.length >= opts.maxModels) break;
    const fresh = liveById.get(id);
    const next: ModelProviderModel = { id };
    if (fresh?.contextWindow) next.contextWindow = fresh.contextWindow;
    if (fresh?.maxOutputTokens) next.maxOutputTokens = fresh.maxOutputTokens;
    if (fresh?.prices) next.prices = fresh.prices;
    if (/claude/i.test(id)) {
      next.efforts = [...CLAUDE_EFFORTS];
      next.defaultEffort = "high";
    }
    out.push(next);
  }
  return out;
}

/** The gateway's base for management reads: `syncUrl` when set, else `baseUrl`. */
export function syncBase(row: ModelProviderRow): string {
  return normalizeGatewayBaseUrl(row.syncUrl || row.baseUrl || "");
}

/** The token a management read uses: the organization's, else the caller's own. */
async function managementToken(row: ModelProviderRow, actor: ProviderViewer): Promise<string> {
  const token =
    storedGatewayToken(row) ??
    (await organizationGatewayToken(row)) ??
    (await personalGatewayToken(row, actor.userId));
  if (!token) {
    throw new GatewayTokenMissingError(
      "The organization has no gateway token — an admin adds one under Settings → Model gateway",
      "global",
    );
  }
  return token;
}

async function requireGateway(
  providerId: string,
  actor: ProviderViewer,
): Promise<ModelProviderRow> {
  const row = /^[0-9a-f-]{36}$/i.test(providerId) ? await getModelProviderRow(providerId) : null;
  if (!row || (row.workspaceId ?? null) !== (actor.workspaceId ?? null)) {
    throw new ModelProviderError("Model provider not found", 404);
  }
  if (row.kind !== "gateway") throw new ModelProviderError(`"${row.name}" isn't a model gateway`);
  return row;
}

/**
 * `GET /v1/models` with the token, every page (an Anthropic-style list
 * pages with `has_more` / `last_id`): the ids, or the status that stopped it.
 */
export async function listGatewayModels(
  row: ModelProviderRow,
  base: string,
  token: string,
): Promise<{ status: number; ids: string[]; body: unknown }> {
  const headers = authHeaders(row, token);
  let res = await getJson(`${base}/v1/models`, headers);
  if (res.status !== 200) return { status: res.status, ids: [], body: res.body };
  const ids = parseModelList(res.body);
  for (let page = 1; page < MAX_MODEL_PAGES; page++) {
    const b = (res.body ?? {}) as { has_more?: unknown; last_id?: unknown };
    if (b.has_more !== true || typeof b.last_id !== "string" || !b.last_id) break;
    res = await getJson(
      `${base}/v1/models?after_id=${encodeURIComponent(b.last_id)}&limit=1000`,
      headers,
    );
    if (res.status !== 200) break;
    ids.push(...parseModelList(res.body));
  }
  return { status: 200, ids: [...new Set(ids)], body: null };
}

/**
 * What a gateway other than LiteLLM serves: OpenRouter's `/api/v1/models`
 * with context lengths and prices; Portkey's and a generic gateway's
 * `/v1/models`, ids only.
 */
async function readCatalog(
  row: ModelProviderRow,
  type: ModelGatewayType,
  token: string,
): Promise<{ live: LiveGatewayModel[]; served: string[] }> {
  const base = normalizeGatewayBaseUrl(row.baseUrl ?? "");
  let res: { status: number; body: unknown; ids?: string[] };
  try {
    res =
      type === "openrouter"
        ? await getJson(`${base}/v1/models`, authHeaders(row, token))
        : await listGatewayModels(row, base, token);
  } catch (err) {
    throw new ModelProviderError(`Couldn't reach the gateway: ${describeFailure(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ModelProviderError("The gateway refused the token (401/403): check the token");
  }
  if (res.status !== 200) {
    throw new ModelProviderError(`The gateway listed no models (/v1/models ${res.status})`);
  }
  if (type === "openrouter") {
    const live = parseOpenRouterModels(res.body);
    return { live, served: live.map((m) => m.id) };
  }
  return { live: [], served: res.ids ?? [] };
}

/**
 * `POST /api/model-providers/:id/sync`: read what the gateway serves with
 * the organization's token (or the caller's) and merge it into the catalog
 * of every agent the gateway serves — LiteLLM's `/model/info` and
 * `/v1/models`; OpenRouter's models with their context lengths and prices
 * (for the models the catalog already lists: OpenRouter lists hundreds);
 * Portkey's and a generic gateway's `/v1/models` ids. Admins only (the route
 * checks); the row's `lastSyncedAt` records it.
 */
export async function syncGatewayCatalog(providerId: string, actor: ProviderViewer) {
  const row = await requireGateway(providerId, actor);
  const token = await managementToken(row, actor);
  const type = modelGatewayTypeOf(row.gatewayType);
  let live: LiveGatewayModel[];
  let served: string[];
  if (type === "litellm") {
    const base = syncBase(row);
    const headers = authHeaders(row, token);
    let info: { status: number; body: unknown };
    let list: { status: number; body: unknown };
    try {
      [info, list] = await Promise.all([
        getJson(`${base}/model/info`, headers),
        getJson(`${base}/v1/models`, headers),
      ]);
    } catch (err) {
      throw new ModelProviderError(`Couldn't reach the gateway: ${describeFailure(err)}`);
    }
    if (info.status === 401 || list.status === 401 || info.status === 403 || list.status === 403) {
      throw new ModelProviderError("The gateway refused the token (401/403): check the token");
    }
    live = info.status === 200 ? parseModelInfo(info.body) : [];
    served = list.status === 200 ? parseModelList(list.body) : [];
    if (live.length === 0 && served.length === 0) {
      throw new ModelProviderError(
        `The gateway listed no models (/model/info ${info.status}, /v1/models ${list.status})`,
      );
    }
  } else {
    ({ live, served } = await readCatalog(row, type, token));
    if (served.length === 0) {
      throw new ModelProviderError("The gateway listed no models (/v1/models)");
    }
  }
  const addsModels = modelGatewayCapabilities(type).catalogAddsModels;
  const agents = row.agents.filter(isModelProviderAgent);
  const current = gatewayOf(row).models;
  if (!addsModels && agents.every((a) => (current[a] ?? []).length === 0)) {
    throw new ModelProviderError(
      `${modelGatewayTypeInfo(type).label} serves ${served.length} models: add the ids you want ` +
        "to the catalog, then Sync fills in their context windows and prices",
    );
  }
  const models: Record<string, ModelProviderModel[]> = {};
  for (const agent of agents) {
    models[agent] =
      type === "litellm"
        ? mergeGatewayCatalog(current[agent] ?? [], live, served)
        : mergeGatewayCatalog(current[agent] ?? [], live, served, {
            addNew: addsModels,
            maxModels: MAX_SYNCED_MODELS,
          });
  }
  const [saved] = await db
    .update(modelProviders)
    .set({ models: cleanModels(models, agents), lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(modelProviders.id, row.id))
    .returning();
  return {
    provider: toModelProvider(saved, actor),
    synced: { models: live.length || served.length, missing: countMissing(saved) },
  };
}

function countMissing(row: ModelProviderRow): number {
  return Object.values(gatewayOf(row).models)
    .flat()
    .filter((m) => m?.missing).length;
}

// ── Test and budget ──────────────────────────────────────────────────────────

export interface GatewayTestResult {
  ok: boolean;
  /** How many models the gateway lists for the token. */
  modelCount: number;
  error?: string;
}

/**
 * `GET /v1/models` with the token: does the gateway answer, and with what.
 * OpenRouter lists its models to anyone, so its token is tried on
 * `/api/v1/key` first.
 */
export async function gatewayTest(
  row: ModelProviderRow,
  token: string,
): Promise<GatewayTestResult> {
  const base = normalizeGatewayBaseUrl(row.baseUrl ?? "");
  try {
    if (modelGatewayTypeOf(row.gatewayType) === "openrouter") {
      const key = await getJson(`${base}/v1/key`, authHeaders(row, token));
      if (key.status === 401 || key.status === 403) {
        return { ok: false, modelCount: 0, error: `The gateway refused the token (${key.status})` };
      }
    }
    const res = await getJson(`${base}/v1/models`, authHeaders(row, token));
    if (res.status === 401 || res.status === 403) {
      return { ok: false, modelCount: 0, error: `The gateway refused the token (${res.status})` };
    }
    if (res.status !== 200) {
      return {
        ok: false,
        modelCount: 0,
        error: `The gateway answered ${res.status} to /v1/models`,
      };
    }
    return { ok: true, modelCount: parseModelList(res.body).length };
  } catch (err) {
    return {
      ok: false,
      modelCount: 0,
      error: `Couldn't reach the gateway: ${describeFailure(err)}`,
    };
  }
}

/** A gateway's budget for a token (LiteLLM `GET /key/info`, OpenRouter `GET /api/v1/key`): what the Overview shows. */
export interface GatewayKeyInfo {
  /** USD spent so far. */
  spend: number;
  /** USD; null = no cap. */
  maxBudget: number | null;
  /** ISO time the spend resets, when it does. */
  budgetResetAt: string | null;
  keyAlias: string | null;
}

/** LiteLLM `/key/info` → `{ info: { spend, max_budget, budget_reset_at, key_alias } }`. */
export function parseKeyInfo(body: unknown): GatewayKeyInfo | null {
  const info = (body as { info?: Record<string, unknown> | null })?.info;
  if (!info || typeof info !== "object") return null;
  const spend = typeof info.spend === "number" ? info.spend : Number(info.spend ?? 0);
  const maxBudget =
    info.max_budget === null || info.max_budget === undefined ? null : Number(info.max_budget);
  const reset = info.budget_reset_at;
  return {
    spend: Number.isFinite(spend) ? spend : 0,
    maxBudget: maxBudget !== null && Number.isFinite(maxBudget) ? maxBudget : null,
    budgetResetAt: typeof reset === "string" && reset ? reset : null,
    keyAlias: typeof info.key_alias === "string" && info.key_alias ? info.key_alias : null,
  };
}

/**
 * The token's own budget from the gateway, or null when the gateway doesn't
 * report one (a type without `tokenBudget`; a 404, no `info`) or can't be
 * reached — the panel then stays quiet.
 */
export async function gatewayKeyInfo(
  row: ModelProviderRow,
  token: string,
): Promise<GatewayKeyInfo | null> {
  try {
    const res = await gatewayKeyInfoRaw(row, token);
    if (res.status !== 200) return null;
    return parseKeyInfo(res.body);
  } catch {
    return null;
  }
}

/**
 * OpenRouter's `GET /api/v1/key` answer (`{ data: { limit, limit_remaining,
 * usage…, limit_reset, expires_at, label } }`) in the shape Optio reads a
 * token's budget in, LiteLLM's `/key/info`: `{ info: { spend, max_budget,
 * budget_reset_at, budget_duration, expires, blocked, key_alias } }`.
 */
export function openRouterKeyInfo(body: unknown, now = new Date()): unknown {
  const data = (body as { data?: Record<string, unknown> | null })?.data;
  if (!data || typeof data !== "object") return body;
  const spend = openRouterSpend(data, now);
  return {
    info: {
      spend: spend.spend,
      max_budget: spend.maxBudget,
      budget_reset_at: spend.budgetResetAt,
      budget_duration: spend.budgetDuration,
      expires: typeof data.expires_at === "string" ? data.expires_at : null,
      blocked: spend.blocked,
      key_alias: typeof data.label === "string" ? data.label : null,
    },
  };
}

/**
 * The gateway's answer about the token itself, as it came (LiteLLM `GET
 * /key/info`; OpenRouter `GET /api/v1/key`, in `/key/info`'s shape): the
 * HTTP status and the body (credential health and the run pre-flight read
 * `expires`, `blocked` and the budget from it, and a 401 as a verdict). A
 * gateway whose type doesn't report a token's budget answers 404 without a
 * call. Throws when the gateway can't be reached — `describeFailure` says why.
 */
export async function gatewayKeyInfoRaw(
  row: ModelProviderRow,
  token: string,
): Promise<{ status: number; body: unknown }> {
  const type = modelGatewayTypeOf(row.gatewayType);
  if (!modelGatewayCapabilities(type).tokenBudget) return { status: 404, body: null };
  if (type === "openrouter") {
    const base = normalizeGatewayBaseUrl(row.baseUrl ?? "");
    const res = await getJson(`${base}/v1/key`, authHeaders(row, token));
    return res.status === 200 ? { status: 200, body: openRouterKeyInfo(res.body) } : res;
  }
  return getJson(`${syncBase(row)}/key/info`, authHeaders(row, token));
}

// ── The workspace's default gateway ──────────────────────────────────────────

/**
 * The gateway the New work form offers by default: the one the workspace
 * names (`default_model_provider_id`), else the organization's first (by
 * creation) so a single gateway needs no extra step. Null when there's none.
 */
export async function defaultGateway(
  workspaceId: string | null | undefined,
): Promise<ModelProviderRow | null> {
  const wsId = workspaceId ?? null;
  if (wsId) {
    const [ws] = await db
      .select({ id: workspaces.defaultModelProviderId })
      .from(workspaces)
      .where(eq(workspaces.id, wsId));
    if (ws?.id) {
      const row = await getModelProviderRow(ws.id);
      if (row && row.kind === "gateway" && (row.workspaceId ?? null) === wsId) return row;
    }
  }
  const [first] = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        wsId ? eq(modelProviders.workspaceId, wsId) : isNull(modelProviders.workspaceId),
        eq(modelProviders.kind, "gateway"),
        isNull(modelProviders.ownerUserId),
      ),
    )
    .orderBy(asc(modelProviders.createdAt))
    .limit(1);
  return first ?? null;
}

/** `PUT /api/workspaces/:id/default-gateway`: name the workspace's default gateway (null clears). */
export async function setDefaultGateway(
  workspaceId: string,
  providerId: string | null,
  actor: ProviderViewer,
): Promise<ModelProviderRow | null> {
  if ((actor.workspaceId ?? null) !== workspaceId) {
    throw new ModelProviderError("Workspace not found", 404);
  }
  if (!actor.isAdmin) {
    throw new ModelProviderError("Only admins can pick the organization's default gateway", 403);
  }
  let row: ModelProviderRow | null = null;
  if (providerId) {
    row = await requireGateway(providerId, actor);
    if (row.ownerUserId) {
      throw new ModelProviderError(
        "The default gateway must be the organization's, not a person's",
      );
    }
  }
  await db
    .update(workspaces)
    .set({ defaultModelProviderId: row?.id ?? null, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
  return row;
}

/** Whether any gateway is set up at all (the setup wizard's "agent source" step). */
export async function anyGatewayConfigured(): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(modelProviders)
    .where(eq(modelProviders.kind, "gateway"));
  return (row?.n ?? 0) > 0;
}

/**
 * Whether a gateway of the workspace serves `model` for `agentType` (the
 * assistant's and reviews' model checks accept any such id).
 */
export async function gatewayServesModel(
  workspaceId: string | null | undefined,
  agentType: string,
  model: string,
): Promise<boolean> {
  if (!isModelProviderAgent(agentType)) return false;
  const wsId = workspaceId ?? null;
  const rows = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        wsId ? eq(modelProviders.workspaceId, wsId) : isNull(modelProviders.workspaceId),
        eq(modelProviders.kind, "gateway"),
      ),
    );
  return rows.some((row) => (gatewayOf(row).models[agentType] ?? []).some((m) => m.id === model));
}

/** The default pick for the workspace's default gateway, for `agentType` (null = no gateway). */
export async function defaultGatewayPick(
  workspaceId: string | null | undefined,
  agentType: string,
  agentOptions: Record<string, unknown> | null | undefined,
): Promise<{
  row: ModelProviderRow;
  agent: ModelProviderAgent;
  pick: ReturnType<typeof gatewayModelPick>;
} | null> {
  if (!isModelProviderAgent(agentType)) return null;
  const row = await defaultGateway(workspaceId);
  if (!row || !row.agents.includes(agentType)) return null;
  return { row, agent: agentType, pick: gatewayModelPick(gatewayOf(row), agentType, agentOptions) };
}

// ── The viewer's tokens (Settings → My tokens, the Overview's budget panel) ──

export interface ViewerGatewayStatus {
  /** The default gateway, or null when the workspace has none. */
  gateway: {
    id: string;
    name: string;
    baseUrl: string;
    authHeader: ModelProviderRow["authHeader"];
    tokenSource: ModelProviderRow["tokenSource"];
    /** The secret name a token is stored under (`ANTHROPIC_AUTH_TOKEN` …). */
    secretName: string;
  } | null;
  /** The viewer has their own token (always true for a `stored` gateway). */
  hasToken: boolean;
  /** The gateway's budget for the viewer's token, when it reports one. */
  keyInfo: GatewayKeyInfo | null;
  /** The viewer's teams and whether each has a token. */
  teams: Array<{ id: string; name: string; hasToken: boolean }>;
  /** The organization's token exists (the organization's own work uses it). */
  orgHasToken: boolean;
}

/** `GET /api/gateway/me`: where the viewer stands with the default gateway. */
export async function viewerGatewayStatus(
  viewer: ProviderViewer,
  teamIds: string[],
): Promise<ViewerGatewayStatus> {
  const row = await defaultGateway(viewer.workspaceId);
  if (!row) return { gateway: null, hasToken: false, keyInfo: null, teams: [], orgHasToken: false };
  const secretName = tokenSecretNameOf(row);
  const stored = row.tokenSource === "stored";
  const personal = stored ? null : await personalGatewayToken(row, viewer.userId);
  const token = stored ? storedGatewayToken(row) : personal;
  const keyInfo = token ? await gatewayKeyInfo(row, token) : null;
  const orgHasToken = stored ? true : (await organizationGatewayToken(row)) !== null;
  const teamRows =
    teamIds.length > 0 && viewer.workspaceId
      ? await db
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(and(inArray(teams.id, teamIds), eq(teams.workspaceId, viewer.workspaceId)))
          .orderBy(asc(teams.name))
      : [];
  const teamStatus = await Promise.all(
    teamRows.map(async (t) => ({
      id: t.id,
      name: t.name,
      hasToken: stored
        ? true
        : await retrieveSecret(secretName, "team", viewer.workspaceId, undefined, t.id)
            .then(() => true)
            .catch(() => false),
    })),
  );
  return {
    gateway: {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl ?? "",
      authHeader: row.authHeader,
      tokenSource: row.tokenSource,
      secretName,
    },
    hasToken: stored || personal !== null,
    keyInfo,
    teams: teamStatus,
    orgHasToken,
  };
}

/** What `GET /api/gateway/me/usage` says about one token: whether it exists, and the gateway's budget for it. */
export interface GatewayTokenUsage {
  hasToken: boolean;
  /** Null when there's no token, the gateway reports no budget, or the viewer may not read it. */
  keyInfo: GatewayKeyInfo | null;
}

export interface ViewerGatewayUsage {
  gateway: { id: string; name: string; baseUrl: string } | null;
  /** The viewer's own token (the shared one, for a `stored` gateway). */
  personal: GatewayTokenUsage;
  /** The viewer's teams, each with its token's budget. */
  teams: Array<GatewayTokenUsage & { teamId: string; name: string }>;
  /** The organization's token; its budget is read for admins only. */
  organization: GatewayTokenUsage;
}

/**
 * `GET /api/gateway/me/usage`: the gateway's own budgets for the viewer —
 * their token's, each of their teams' and (admins) the organization's —
 * where the gateway reports one (`gatewayKeyInfo`). This stands in for the Claude.ai usage
 * limits, which a gateway-only deployment never asks about.
 */
export async function viewerGatewayUsage(
  viewer: ProviderViewer,
  teamIds: string[],
): Promise<ViewerGatewayUsage> {
  const none: GatewayTokenUsage = { hasToken: false, keyInfo: null };
  const row = await defaultGateway(viewer.workspaceId);
  if (!row) return { gateway: null, personal: none, teams: [], organization: none };
  const secretName = tokenSecretNameOf(row);
  const usageOf = async (token: string | null, readable = true): Promise<GatewayTokenUsage> => ({
    hasToken: token !== null,
    keyInfo: token && readable ? await gatewayKeyInfo(row, token) : null,
  });
  const stored = storedGatewayToken(row);
  const teamRows =
    teamIds.length > 0 && viewer.workspaceId
      ? await db
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(and(inArray(teams.id, teamIds), eq(teams.workspaceId, viewer.workspaceId)))
          .orderBy(asc(teams.name))
      : [];
  const [personal, teamUsage, organization] = await Promise.all([
    usageOf(stored ?? (await personalGatewayToken(row, viewer.userId))),
    Promise.all(
      teamRows.map(async (t) => ({
        teamId: t.id,
        name: t.name,
        ...(await usageOf(
          stored
            ? null
            : await retrieveSecret(secretName, "team", viewer.workspaceId, undefined, t.id).catch(
                () => null,
              ),
        )),
        // A stored gateway's one token is the team's too; its budget is the personal one.
        ...(stored ? { hasToken: true } : {}),
      })),
    ),
    stored
      ? Promise.resolve<GatewayTokenUsage>({ hasToken: true, keyInfo: null })
      : usageOf(await organizationGatewayToken(row), viewer.isAdmin),
  ]);
  return {
    gateway: { id: row.id, name: row.name, baseUrl: row.baseUrl ?? "" },
    personal,
    teams: teamUsage,
    organization,
  };
}

/**
 * `PUT /api/gateway/me/token`: store the viewer's own token for the default
 * gateway (a user-scope secret under the gateway's name) and try it.
 */
export async function storePersonalGatewayToken(
  viewer: ProviderViewer,
  token: string,
): Promise<{ secretName: string; test: GatewayTestResult }> {
  if (!viewer.userId) throw new ModelProviderError("Sign in to add your own gateway token", 403);
  const row = await defaultGateway(viewer.workspaceId);
  if (!row) throw new ModelProviderError("The workspace has no model gateway yet", 404);
  const value = token.trim();
  if (!value) throw new ModelProviderError("The token is empty");
  const secretName = tokenSecretNameOf(row);
  await storeSecret(secretName, value, "user", null, viewer.userId);
  return { secretName, test: await gatewayTest(row, value) };
}

/** Whether the viewer may see (and so test) a provider: the organization's, or their own. */
export function canSeeProvider(row: ModelProviderRow, viewer: ProviderViewer): boolean {
  if ((row.workspaceId ?? null) !== (viewer.workspaceId ?? null)) return false;
  return !row.ownerUserId || viewer.isAdmin || row.ownerUserId === viewer.userId;
}

/**
 * `POST /api/model-providers/:id/test`: try a token against the gateway —
 * the one given, else the caller's own (or the stored one).
 */
export async function testGateway(
  providerId: string,
  viewer: ProviderViewer,
  token?: string | null,
): Promise<GatewayTestResult & { tokenFrom: "given" | "stored" | "personal" }> {
  const row = await requireGateway(providerId, viewer);
  if (!canSeeProvider(row, viewer)) throw new ModelProviderError("Model provider not found", 404);
  const given = token?.trim();
  if (given) return { ...(await gatewayTest(row, given)), tokenFrom: "given" };
  const stored = storedGatewayToken(row);
  if (stored) return { ...(await gatewayTest(row, stored)), tokenFrom: "stored" };
  const personal = await personalGatewayToken(row, viewer.userId);
  if (!personal) {
    throw new GatewayTokenMissingError("Add your gateway token under Settings → My tokens", "user");
  }
  return { ...(await gatewayTest(row, personal)), tokenFrom: "personal" };
}
