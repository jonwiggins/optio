import {
  gatewayTokenConsent,
  hasGatewayTokenConsent,
  legacyConsentMatches,
} from "./gateway-token-consent.js";
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { guardedFetch } from "../utils/outbound-url.js";
import { openRouterSpend, parseOpenRouterKey } from "./openrouter-key.js";
import {
  gatewayTokenSecretName,
  isModelProviderAgent,
  modelGatewayCapabilities,
  modelGatewayTypeInfo,
  modelGatewayTypeOf,
  normalizeGatewayBaseUrl,
  type ModelGatewayType,
  type ModelProviderModel,
  currentFeatures,
} from "@optio/shared";
import { db } from "../db/client.js";
import { modelProviders, secrets, workspaces } from "../db/schema.js";
import { logger } from "../logger.js";
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
import {
  ALG_AES_256_GCM_V1,
  buildSecretAAD,
  decrypt,
  encrypt,
  retrieveGatewayTokenSecret,
  storeSecret,
} from "./secret-service.js";

/**
 * The model gateway (docs/model-gateway.md): the token a run gets, the
 * catalog sync from the gateway (per its type: LiteLLM, OpenRouter, Portkey
 * or any OpenAI- / Anthropic-compatible endpoint), the connection test, the
 * viewer's budget,
 * and a workspace's default gateway.
 *
 * Tokens: a run gets exactly one — personal work its owner's, the
 * organization's work the organization's — stored as `gateway:<providerId>`
 * (at user scope, or at `GATEWAY_TOKEN_SCOPE` in the gateway's workspace)
 * and mapped to the env name the agent CLI reads only at launch. Every read
 * goes through `readGatewayToken`, which hands out a token only while its
 * consent matches the gateway's URLs. There is no fallback to someone
 * else's key: a missing token fails with a message that says where to add
 * it, so the gateway's spend ledger stays per person.
 */

/** A gateway token is missing for the work's owner; `message` says where to add it. */
export class GatewayTokenMissingError extends ModelProviderError {
  constructor(
    message: string,
    readonly scope: "user" | "global",
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
}

/**
 * The scope an organization's gateway token is stored at: bound to the
 * gateway's workspace (never `global`, which is instance-wide and which
 * `resolveSecretsForSetup` hands to every repo pod).
 */
export const GATEWAY_TOKEN_SCOPE = "gateway";

/** The name of the secret that holds a token for this gateway (`gateway:<id>`). */
export function tokenSecretNameOf(row: Pick<ModelProviderRow, "id">): string {
  return gatewayTokenSecretName(row.id);
}

/**
 * The token a run of `provider` gets: the sealed one for a `stored` gateway;
 * otherwise the work owner's own — the person's for personal work, the
 * organization's for the organization's. Throws `GatewayTokenMissingError`
 * when it isn't there.
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
  if (use.ownerUserId) {
    const token = await personalGatewayToken(provider, use.ownerUserId);
    if (token) return token;
    throw new GatewayTokenMissingError(
      `Add your token for "${provider.name}" under Settings → My tokens`,
      "user",
    );
  }
  const token = await organizationGatewayToken(provider);
  if (token) return token;
  throw new GatewayTokenMissingError(
    `The organization has no token for "${provider.name}" — an admin adds one under Settings → My tokens`,
    "global",
  );
}

/**
 * The one way a gateway token is read: the secret `gateway:<id>` at user
 * scope (a person's) or in the gateway's workspace (the organization's),
 * handed out only when its consent names this gateway at its current URLs.
 * A token stored before the gateway's URL changed reads as missing until it
 * is entered again.
 */
async function readGatewayToken(
  row: ModelProviderRow,
  owner: { userId: string } | "organization",
): Promise<string | null> {
  if (row.kind !== "gateway") return null;
  const name = tokenSecretNameOf(row);
  const found = await (
    owner === "organization"
      ? retrieveGatewayTokenSecret(name, GATEWAY_TOKEN_SCOPE, row.workspaceId ?? null, null)
      : retrieveGatewayTokenSecret(name, "user", null, owner.userId)
  ).catch(() => null);
  if (!found || !hasGatewayTokenConsent(found.consent, row)) return null;
  return found.value;
}

/** The organization's token for the gateway (its workspace's), or null. */
export async function organizationGatewayToken(row: ModelProviderRow): Promise<string | null> {
  return readGatewayToken(row, "organization");
}

/** A person's own token for the gateway, or null. */
export async function personalGatewayToken(
  row: ModelProviderRow,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  return readGatewayToken(row, { userId });
}

/** Store a token for the gateway with its consent (`gateway-token-consent.ts`). */
async function writeGatewayToken(
  row: ModelProviderRow,
  owner: { userId: string } | "organization",
  token: string,
): Promise<void> {
  const value = token.trim();
  if (!value) throw new ModelProviderError("The token is empty");
  if (owner === "organization") {
    await storeSecret(
      tokenSecretNameOf(row),
      value,
      GATEWAY_TOKEN_SCOPE,
      row.workspaceId ?? null,
      null,
      gatewayTokenConsent(row),
    );
  } else {
    await storeSecret(
      tokenSecretNameOf(row),
      value,
      "user",
      null,
      owner.userId,
      gatewayTokenConsent(row),
    );
  }
}

/**
 * The vendor env names an earlier build of this feature stored gateway
 * tokens under (`migrateLegacyGatewayTokens`).
 */
const LEGACY_GATEWAY_TOKEN_NAMES = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

/** Advisory lock for `migrateLegacyGatewayTokens`, distinct from the secret heals'. */
const LEGACY_GATEWAY_TOKENS_LOCK_ID = 8_675_313;

/**
 * Move gateway tokens an earlier build stored under vendor env names to
 * `gateway:<providerId>`. Only rows that carry a gateway consent are
 * touched: only the gateway's own token routes ever wrote one, so a real
 * vendor key (no consent) is never read, moved or deleted. A row whose
 * gateway still exists and whose consent still matches it is re-encrypted
 * under the new name with today's consent (unless that name already holds
 * a token); every such row is then deleted from the vendor name, so a run
 * that doesn't use the gateway can no longer pick it up. Idempotent; runs
 * at boot under a transaction-scoped advisory lock.
 */
export async function migrateLegacyGatewayTokens(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${sql.raw(String(LEGACY_GATEWAY_TOKENS_LOCK_ID))})`,
    );
    const legacy = await tx
      .select()
      .from(secrets)
      .where(
        and(inArray(secrets.name, LEGACY_GATEWAY_TOKEN_NAMES), isNotNull(secrets.gatewayConsent)),
      );
    let moved = 0;
    for (const old of legacy) {
      try {
        const providerId = old.gatewayConsent?.providerId;
        const [row] =
          typeof providerId === "string" && /^[0-9a-f-]{36}$/i.test(providerId)
            ? await tx.select().from(modelProviders).where(eq(modelProviders.id, providerId))
            : [];
        const scope = old.scope === "user" ? "user" : old.scope === "global" ? "global" : null;
        if (
          row &&
          row.kind === "gateway" &&
          scope &&
          legacyConsentMatches(old.gatewayConsent, row)
        ) {
          const value = decrypt(
            {
              alg: old.alg ?? ALG_AES_256_GCM_V1,
              iv: old.iv,
              ciphertext: old.encryptedValue,
              authTag: old.authTag,
            },
            buildSecretAAD(old.name, old.scope, old.workspaceId),
            old.name,
          );
          const name = gatewayTokenSecretName(row.id);
          const [taken] = await tx
            .select({ id: secrets.id })
            .from(secrets)
            .where(
              scope === "user"
                ? and(
                    eq(secrets.name, name),
                    eq(secrets.scope, "user"),
                    eq(secrets.userId, old.userId!),
                  )
                : and(
                    eq(secrets.name, name),
                    eq(secrets.scope, GATEWAY_TOKEN_SCOPE),
                    row.workspaceId
                      ? eq(secrets.workspaceId, row.workspaceId)
                      : isNull(secrets.workspaceId),
                  ),
            );
          if (!taken) {
            const newScope = scope === "user" ? "user" : GATEWAY_TOKEN_SCOPE;
            const workspaceId = scope === "user" ? null : (row.workspaceId ?? null);
            const sealed = encrypt(value, buildSecretAAD(name, newScope, workspaceId));
            await tx.insert(secrets).values({
              name,
              scope: newScope,
              workspaceId,
              userId: scope === "user" ? old.userId : null,
              encryptedValue: sealed.ciphertext,
              iv: sealed.iv,
              authTag: sealed.authTag,
              alg: sealed.alg,
              gatewayConsent: { ...gatewayTokenConsent(row) },
            });
            moved++;
          }
        }
        await tx.delete(secrets).where(eq(secrets.id, old.id));
      } catch (err) {
        logger.error(
          { err, name: old.name, userId: old.userId },
          "migrateLegacyGatewayTokens: failed to move a gateway token — leaving it for review",
        );
      }
    }
    if (legacy.length > 0) {
      logger.info({ moved, total: legacy.length }, "migrateLegacyGatewayTokens complete");
    }
    return moved;
  });
}

// ── HTTP to the gateway ──────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;

type GatewayFetch = (url: string, init?: RequestInit) => Promise<Response>;

let fetchOverride: GatewayFetch | null = null;

/** Tests: route the gateway's HTTP through a stand-in (null restores the guard). */
export function setGatewayFetchForTests(fetchImpl: GatewayFetch | null): void {
  fetchOverride = fetchImpl;
}

/**
 * Guarded requests bound to the deployment's outbound policy and TLS trust.
 * Node adds `NODE_EXTRA_CA_CERTS` (the chart mounts its
 * `caBundle` there) to its roots; `OPTIO_GATEWAY_CA_PEM` names a CA for
 * the gateway alone, and `OPTIO_GATEWAY_INSECURE_SKIP_VERIFY=true` is for a
 * lab with no CA at all.
 */
export function gatewayFetch(): GatewayFetch {
  if (fetchOverride) return fetchOverride;
  const ca = process.env.OPTIO_GATEWAY_CA_PEM?.trim();
  return (url, init) => {
    const parsed = new URL(url);
    if (parsed.hash || parsed.username || parsed.password) {
      throw new ModelProviderError("Gateway URLs cannot contain fragments or user credentials");
    }
    return guardedFetch(url, {
      ...init,
      redirect: "error",
      timeoutMs: REQUEST_TIMEOUT_MS,
      tls: {
        ...(ca ? { ca } : {}),
        rejectUnauthorized: process.env.OPTIO_GATEWAY_INSECURE_SKIP_VERIFY !== "true",
      },
    });
  };
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
  // Portkey takes its key in its own header, and nothing else: no bearer
  // token goes beside it.
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

/** The most a gateway's answer may hold: a catalog of a few thousand models fits easily. */
export const MAX_GATEWAY_BODY_BYTES = 4 * 1024 * 1024;

/** The body as text, or null once it passes `max` bytes (the rest is never read). */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A GET to the gateway: the status and the JSON body, or a null body when
 * it isn't JSON or is larger than `MAX_GATEWAY_BODY_BYTES`.
 */
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
    const text = await readCapped(res, MAX_GATEWAY_BODY_BYTES);
    body = text === null ? null : JSON.parse(text);
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

/** The most entries a catalog answer is read for (`/model/info`, `/v1/models`). */
export const MAX_CATALOG_ENTRIES = 5000;

/** A model id the catalog takes (the same bound `routes/model-providers.ts` sets). */
const modelIdSchema = z.string().trim().min(1).max(200);

/** LiteLLM's `/model/info`, as far as the sync reads it. */
const modelInfoBodySchema = z.object({
  data: z
    .array(
      z
        .object({
          model_name: z.unknown(),
          model_info: z.record(z.string(), z.unknown()).nullish(),
        })
        .passthrough(),
    )
    .max(MAX_CATALOG_ENTRIES),
});

/** An OpenAI-style `/v1/models` (`has_more` / `last_id` when Anthropic-style). */
const modelListBodySchema = z.object({
  data: z.array(z.object({ id: z.unknown() }).passthrough()).max(MAX_CATALOG_ENTRIES),
});

/**
 * LiteLLM `GET /model/info` → `{ data: [{ model_name, model_info: {
 * max_input_tokens, max_output_tokens, input_cost_per_token, … } }] }`:
 * `model_name` → `id`, the token limits, and per-token costs × 1e6 → USD per
 * million tokens. Models with the same name (a deployment group) merge. An
 * answer of another shape, or with more than `MAX_CATALOG_ENTRIES`, reads as
 * none; an entry whose id isn't a valid model id is skipped.
 */
export function parseModelInfo(body: unknown): LiveGatewayModel[] {
  const parsed = modelInfoBodySchema.safeParse(body);
  if (!parsed.success) return [];
  const byId = new Map<string, LiveGatewayModel>();
  for (const e of parsed.data.data) {
    const name = modelIdSchema.safeParse(e.model_name);
    if (!name.success) continue;
    const id = name.data;
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

/** OpenAI-style `GET /v1/models` → the valid ids (none for another shape). */
export function parseModelList(body: unknown): string[] {
  const parsed = modelListBodySchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.data.flatMap((m) => {
    const id = modelIdSchema.safeParse(m.id);
    return id.success ? [id.data] : [];
  });
}

/** OpenRouter's `/api/v1/models`, as far as the sync reads it. */
const openRouterModelsBodySchema = z.object({
  data: z
    .array(
      z
        .object({
          id: z.unknown(),
          context_length: z.unknown().optional(),
          top_provider: z.record(z.string(), z.unknown()).nullish(),
          pricing: z.record(z.string(), z.unknown()).nullish(),
        })
        .passthrough(),
    )
    .max(MAX_CATALOG_ENTRIES),
});

/**
 * OpenRouter `GET /api/v1/models` → `{ data: [{ id, context_length,
 * top_provider: { context_length, max_completion_tokens }, pricing: {
 * prompt, completion, input_cache_read, input_cache_write } }] }`: prices
 * are USD per token as strings (× 1e6 → per million; a negative one, as a
 * router's whose price varies, is left out). An answer of another shape, or
 * with more than `MAX_CATALOG_ENTRIES`, reads as none; an entry whose id
 * isn't a valid model id is skipped.
 */
export function parseOpenRouterModels(body: unknown): LiveGatewayModel[] {
  const parsed = openRouterModelsBodySchema.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.data.flatMap((e) => {
    const id = modelIdSchema.safeParse(e.id);
    if (!id.success) return [];
    const top = e.top_provider ?? {};
    const pricing = e.pricing ?? {};
    const model: LiveGatewayModel = { id: id.data };
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

/** The most models a sync fills a catalog up to (what `routes/model-providers.ts` accepts per agent). */
export const MAX_SYNCED_MODELS = 50;

/**
 * The catalog after a sync: what the gateway reports overwrites the numbers
 * (limits, prices) of models the admin already listed and keeps their names,
 * efforts and roles; new ids are appended (a Claude model gets the five
 * efforts) up to `maxModels`; models the gateway stopped serving stay,
 * flagged `missing`.
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

/**
 * The token a management read uses: the stored one, else the
 * organization's, else the caller's own (each through `readGatewayToken`).
 */
async function managementToken(row: ModelProviderRow, actor: ProviderViewer): Promise<string> {
  const token =
    storedGatewayToken(row) ??
    (await organizationGatewayToken(row)) ??
    (await personalGatewayToken(row, actor.userId));
  if (!token) {
    throw new GatewayTokenMissingError(
      `No token for "${row.name}" yet — add the organization's or your own under Settings → My tokens`,
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
 * `/v1/models`; OpenRouter's models with their context lengths and prices,
 * for the models the catalog already names (it lists hundreds); Portkey's
 * and a generic gateway's `/v1/models` ids. Admins only (the route checks);
 * the row's `lastSyncedAt` records it.
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
    models[agent] = mergeGatewayCatalog(current[agent] ?? [], live, served, {
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
      if (key.status !== 200 || !parseOpenRouterKey(key.body)) {
        return {
          ok: false,
          modelCount: 0,
          error:
            key.status === 401 || key.status === 403
              ? `The gateway refused the token (${key.status})`
              : `The gateway answered ${key.status} to /v1/key`,
        };
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

/**
 * A gateway's budget for a token (LiteLLM `GET /key/info`, OpenRouter `GET
 * /api/v1/key`): what the Overview shows.
 */
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
 * usage…, limit_reset, expires_at, disabled, label } }`) in the shape Optio
 * reads a token's budget in, LiteLLM's `/key/info`: `{ info: { spend,
 * max_budget, budget_reset_at, budget_duration, expires, blocked, key_alias
 * } }`. Null for an answer of another shape.
 */
export function openRouterKeyInfo(body: unknown, now = new Date()): { info: object } | null {
  const key = parseOpenRouterKey(body);
  if (!key) return null;
  const spend = openRouterSpend(key, now);
  return {
    info: {
      spend: spend.spend,
      max_budget: spend.maxBudget,
      budget_reset_at: spend.budgetResetAt,
      budget_duration: spend.budgetDuration,
      expires: key.expires_at ?? null,
      blocked: spend.blocked,
      key_alias: key.label ?? null,
    },
  };
}

/**
 * The gateway's answer about the token itself, as it came (LiteLLM `GET
 * /key/info`; OpenRouter `GET /api/v1/key`, in `/key/info`'s shape): the
 * HTTP status and the body. A gateway whose type doesn't report a token's
 * budget answers 404 without a call. Throws when the gateway can't be
 * reached — `describeFailure` says why.
 */
export async function gatewayKeyInfoRaw(
  row: ModelProviderRow,
  token: string,
): Promise<{ status: number; body: unknown }> {
  const type = modelGatewayTypeOf(row.gatewayType);
  if (!modelGatewayCapabilities(type).tokenBudget) return { status: 404, body: null };
  if (type === "openrouter") {
    // OpenRouter has no sync URL: the key route is under the base URL.
    const base = normalizeGatewayBaseUrl(row.baseUrl ?? "");
    const res = await getJson(`${base}/v1/key`, authHeaders(row, token));
    if (res.status !== 200) return res;
    const info = openRouterKeyInfo(res.body);
    return info ? { status: 200, body: info } : { status: 502, body: null };
  }
  return getJson(`${syncBase(row)}/key/info`, authHeaders(row, token));
}

// ── The workspace's default gateway ──────────────────────────────────────────

/** Whether this deployment reaches models through a gateway only (`OPTIO_MODEL_ACCESS=gateway`). */
export function gatewayOnly(): boolean {
  return currentFeatures().modelAccess === "gateway";
}

/**
 * The workspace's default gateway: the one it names
 * (`default_model_provider_id`), else the organization's first (by
 * creation). Null when there's none. What Settings → My tokens and the
 * Overview's budget panel show; work runs through it without picking it
 * only in a gateway-only deployment (`implicitGateway`).
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

/**
 * The gateway work runs through when it picks no model provider. In a
 * gateway-only deployment, the default one (`defaultGateway`), as the New
 * work form shows it; otherwise none: a gateway is used only when the work
 * picks it, so adding one never reroutes work that didn't ask for it.
 */
export async function implicitGateway(
  workspaceId: string | null | undefined,
): Promise<ModelProviderRow | null> {
  return gatewayOnly() ? defaultGateway(workspaceId) : null;
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

// ── The viewer's tokens (Settings → My tokens, the Overview's budget panel) ──

export interface ViewerGatewayStatus {
  /** The default gateway, or null when the workspace has none. */
  gateway: {
    id: string;
    name: string;
    baseUrl: string;
    authHeader: ModelProviderRow["authHeader"];
    tokenSource: ModelProviderRow["tokenSource"];
  } | null;
  /** The viewer has their own token (always true for a `stored` gateway). */
  hasToken: boolean;
  /** The gateway's budget for the viewer's token, when it reports one. */
  keyInfo: GatewayKeyInfo | null;
  /** The organization's token exists (the organization's own work uses it). */
  orgHasToken: boolean;
}

/** `GET /api/gateway/me`: where the viewer stands with the default gateway. */
export async function viewerGatewayStatus(viewer: ProviderViewer): Promise<ViewerGatewayStatus> {
  const row = await defaultGateway(viewer.workspaceId);
  if (!row) return { gateway: null, hasToken: false, keyInfo: null, orgHasToken: false };
  const stored = row.tokenSource === "stored";
  const personal = stored ? null : await personalGatewayToken(row, viewer.userId);
  const token = stored ? storedGatewayToken(row) : personal;
  const keyInfo = token ? await gatewayKeyInfo(row, token) : null;
  const orgHasToken = stored ? true : (await organizationGatewayToken(row)) !== null;
  return {
    gateway: {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl ?? "",
      authHeader: row.authHeader,
      tokenSource: row.tokenSource,
    },
    hasToken: stored || personal !== null,
    keyInfo,
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
  /** The organization's token; its budget is read for admins only. */
  organization: GatewayTokenUsage;
}

/**
 * `GET /api/gateway/me/usage`: the gateway's own budgets for the viewer —
 * their token's and (admins) the organization's — where the gateway reports
 * one (`gatewayKeyInfo`). This stands in for the Claude.ai usage limits,
 * which a gateway-only deployment never asks about.
 */
export async function viewerGatewayUsage(viewer: ProviderViewer): Promise<ViewerGatewayUsage> {
  const none: GatewayTokenUsage = { hasToken: false, keyInfo: null };
  const row = await defaultGateway(viewer.workspaceId);
  if (!row) return { gateway: null, personal: none, organization: none };
  const usageOf = async (token: string | null, readable = true): Promise<GatewayTokenUsage> => ({
    hasToken: token !== null,
    keyInfo: token && readable ? await gatewayKeyInfo(row, token) : null,
  });
  const stored = storedGatewayToken(row);
  const [personal, organization] = await Promise.all([
    usageOf(stored ?? (await personalGatewayToken(row, viewer.userId))),
    stored
      ? Promise.resolve<GatewayTokenUsage>({ hasToken: true, keyInfo: null })
      : usageOf(await organizationGatewayToken(row), viewer.isAdmin),
  ]);
  return {
    gateway: { id: row.id, name: row.name, baseUrl: row.baseUrl ?? "" },
    personal,
    organization,
  };
}

/**
 * The gateway a token route is about: the one named (the viewer must be
 * able to see it), else the workspace's default.
 */
async function tokenRouteGateway(
  viewer: ProviderViewer,
  providerId: string | null | undefined,
): Promise<ModelProviderRow> {
  if (providerId) {
    const row = await requireGateway(providerId, viewer);
    if (!canSeeProvider(row, viewer)) throw new ModelProviderError("Model provider not found", 404);
    return row;
  }
  const row = await defaultGateway(viewer.workspaceId);
  if (!row) throw new ModelProviderError("The workspace has no model gateway yet", 404);
  return row;
}

/**
 * `PUT /api/gateway/me/token`: store the viewer's own token for a gateway
 * (`providerId`, else the workspace's default) as their private secret
 * `gateway:<id>`, bound to the gateway's current URLs, and try it.
 */
export async function storePersonalGatewayToken(
  viewer: ProviderViewer,
  token: string,
  providerId?: string | null,
): Promise<{ providerId: string; test: GatewayTestResult }> {
  if (!viewer.userId) throw new ModelProviderError("Sign in to add your own gateway token", 403);
  const row = await tokenRouteGateway(viewer, providerId);
  await writeGatewayToken(row, { userId: viewer.userId }, token);
  return { providerId: row.id, test: await gatewayTest(row, token.trim()) };
}

/**
 * `PUT /api/model-providers/:id/token`: store the organization's token for
 * one of its gateways (admins only), bound to the gateway's workspace and
 * its current URLs, and try it. A person's own gateway has no organization
 * token.
 */
export async function storeOrganizationGatewayToken(
  providerId: string,
  viewer: ProviderViewer,
  token: string,
): Promise<{ providerId: string; test: GatewayTestResult }> {
  if (!viewer.isAdmin) {
    throw new ModelProviderError("Only admins can set the organization's gateway token", 403);
  }
  const row = await requireGateway(providerId, viewer);
  if (row.ownerUserId) {
    throw new ModelProviderError(
      "A person's own gateway takes their own token, not the organization's",
    );
  }
  await writeGatewayToken(row, "organization", token);
  return { providerId: row.id, test: await gatewayTest(row, token.trim()) };
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
