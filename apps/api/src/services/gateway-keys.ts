import { randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import {
  gatewayBudgetPeriodFor,
  gatewayKeyDefaultsOf,
  gatewayKeyModesOf,
  gatewayTokenSecretName,
  isValidGatewayDuration,
  modelGatewayCapabilities,
  modelGatewayTypeInfo,
  modelGatewayTypeOf,
  personalGatewayKeyAlias,
  type GatewayKeyDefaults,
  type GatewayKeyModes,
  type ModelGatewayCapabilities,
  type ModelGatewayType,
} from "@optio/shared";
import { db } from "../db/client.js";
import { gatewayIssuedKeys, modelProviders, users } from "../db/schema.js";
import { logger } from "../logger.js";
import { LiteLLMError, isAliasTaken } from "./litellm-admin.js";
import {
  GatewayAdminError,
  keyHint,
  keyValueHash,
  type GatewayAdmin,
  type GatewayKeyDriver,
  type GatewaySpend,
  type GenerateKeyInput,
  type GeneratedKey,
} from "./gateway-admin-http.js";
import { adminBaseOf, keyDriver } from "./gateway-admin.js";
import {
  canSeeProvider,
  defaultGateway,
  gatewayTest,
  writeGatewayToken,
  type GatewayTestResult,
} from "./model-gateway-service.js";
import {
  gatewayOf,
  getModelProviderRow,
  type ModelProviderRow,
  type ProviderViewer,
} from "./model-provider-service.js";
import { withLease } from "./lease-service.js";
import { logAction } from "./optio-action-service.js";
import { decrypt, deleteSecret, encrypt, retrieveGatewayTokenSecret } from "./secret-service.js";
import {
  carriedInSpend,
  carriedOf,
  carriedTotal,
  carryAfter,
  durationEnd,
  type CarriedSpend,
} from "./gateway-key-carry.js";

/**
 * Gateway keys made by Optio (docs/model-gateway.md "Keys Optio makes"). The
 * routes are `routes/gateway-keys.ts`, the housekeeping check
 * `gateway-key-check.ts`, and each gateway type's key API a driver
 * (`gateway-admin.ts`: LiteLLM, OpenRouter).
 *
 * Per organization gateway an admin chooses how people get a token: pasted
 * by hand, made by Optio on the gateway, or both (where the type has managed
 * keys). Optio makes keys with the admin key sealed on the gateway row. Its
 * AAD names the gateway, its type and its admin URL, so once any of those
 * changes it no longer decrypts and is never sent anywhere new.
 *
 * A person's key: alias `optio-<user>`, the gateway's budget, budget period
 * and expiry (and on LiteLLM their email as `user_id` and the catalog's
 * models). It is stored as their gateway token (`gateway:<providerId>` with
 * its consent, `writeGatewayToken`), so a run reads it the way it reads a
 * pasted one, through `readGatewayToken`. No route ever returns its value.
 *
 * "Rotate" makes a new key, carrying over what the old one spent this
 * period (gateway-key-carry.ts), and deletes the old one on the gateway. A
 * key whose person leaves the workspace or is deleted is blocked on the
 * gateway (`revokeIssuedGatewayKeys`, and the housekeeping check).
 * `gateway_issued_keys` remembers the SHA-256 of each key's value and the
 * gateway's id for it, never the value. Team keys follow with teams.
 */

/** A refusal with the HTTP status the route answers. */
export class GatewayKeyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502 = 400,
  ) {
    super(message);
    this.name = "GatewayKeyError";
  }
}

type IssuedRow = typeof gatewayIssuedKeys.$inferSelect;

/** Who asks, as the routes see them. */
export type KeyActor = ProviderViewer;

function record(
  actor: { userId?: string | null } | null,
  action: string,
  workspaceId: string | null,
  params: Record<string, unknown>,
) {
  logAction({
    workspaceId,
    userId: actor?.userId ?? undefined,
    action,
    params,
    success: true,
  }).catch(() => {});
}

/** The gateway's failures as this module's refusals (502: the gateway's side). */
function fromGateway(err: unknown): never {
  if (err instanceof GatewayAdminError) {
    if (err.status === 400 && !(err instanceof LiteLLMError)) {
      throw new GatewayKeyError(err.message, 400);
    }
    throw new GatewayKeyError(err.message, err.status === 401 || err.status === 403 ? 400 : 502);
  }
  throw err;
}

// ── The gateway's settings ───────────────────────────────────────────────────

/**
 * What the admin key is sealed under: the gateway, its type and where its
 * admin API answers. A change of any of them makes the stored key unreadable
 * (`adminKeyOf` answers null), so it is never sent to a URL it wasn't given for.
 */
function adminKeyAAD(row: Pick<ModelProviderRow, "id" | "gatewayType" | "baseUrl" | "syncUrl">) {
  return Buffer.from(
    `model_provider_admin_key|${row.id}|${modelGatewayTypeOf(row.gatewayType)}|${adminBaseOf(row)}`,
  );
}

/** What the gateway's type calls the key Optio makes keys with ("LiteLLM admin key"). */
function adminKeyName(row: Pick<ModelProviderRow, "gatewayType">): string {
  return modelGatewayTypeInfo(row.gatewayType).adminKeyName ?? "admin key";
}

/** The admin key sealed on a gateway, or null (none, or sealed for another type or URL). */
export function adminKeyOf(row: ModelProviderRow): string | null {
  if (!row.encryptedAdminKey || !row.adminKeyIv || !row.adminKeyAuthTag) return null;
  try {
    return decrypt(
      {
        alg: 1,
        iv: row.adminKeyIv,
        ciphertext: row.encryptedAdminKey,
        authTag: row.adminKeyAuthTag,
      },
      adminKeyAAD(row),
      `the ${adminKeyName(row)} of ${row.name}`,
    );
  } catch {
    return null;
  }
}

/** The columns that clear a gateway's admin key. */
export const CLEARED_ADMIN_KEY = {
  encryptedAdminKey: null,
  adminKeyIv: null,
  adminKeyAuthTag: null,
} as const;

/** The model ids a gateway's catalog serves (every agent's, models it stopped serving left out). */
export function catalogModelIds(row: ModelProviderRow): string[] {
  const ids = new Set<string>();
  for (const models of Object.values(gatewayOf(row).models ?? {})) {
    for (const m of models ?? []) if (m?.id && !m.missing) ids.add(m.id);
  }
  return [...ids];
}

export interface KeyIssuingSettings {
  providerId: string;
  /** The gateway's type, and what it supports (`modelGatewayCapabilities`). */
  gatewayType: ModelGatewayType;
  capabilities: ModelGatewayCapabilities;
  modes: GatewayKeyModes;
  defaults: GatewayKeyDefaults;
  /** An admin key is stored and still readable for the gateway as it is now. */
  hasAdminKey: boolean;
  /** What "every model" means for a key: the catalog's ids. */
  catalogModels: string[];
  /** Models in `defaults.models` the catalog no longer serves: new keys leave them out. */
  staleModels: string[];
}

/** The stored defaults as the gateway's type takes them (OpenRouter: its periods, no models). */
function defaultsForType(type: ModelGatewayType, d: GatewayKeyDefaults): GatewayKeyDefaults {
  if (type === "litellm") return d;
  return {
    ...d,
    budgetDuration: gatewayBudgetPeriodFor(type, d.budgetDuration),
    models: modelGatewayCapabilities(type).keyModels ? d.models : [],
  };
}

/** The modes a gateway takes: pasting only where Optio can't make keys or a shared token is stored. */
export function keyModesOf(
  row: Pick<ModelProviderRow, "gatewayType" | "keyModes" | "tokenSource" | "ownerUserId">,
): GatewayKeyModes {
  const managed = modelGatewayCapabilities(row.gatewayType).managedKeys;
  if (!managed || row.tokenSource !== "personal" || row.ownerUserId) {
    return { personalPasted: true, optioIssued: false };
  }
  return gatewayKeyModesOf(row.keyModes);
}

export function keyIssuingOf(row: ModelProviderRow): KeyIssuingSettings {
  const gatewayType = modelGatewayTypeOf(row.gatewayType);
  const capabilities = modelGatewayCapabilities(gatewayType);
  const defaults = defaultsForType(gatewayType, gatewayKeyDefaultsOf(row.keyDefaults));
  const catalogModels = catalogModelIds(row);
  return {
    providerId: row.id,
    gatewayType,
    capabilities,
    modes: keyModesOf(row),
    defaults,
    hasAdminKey: adminKeyOf(row) !== null,
    catalogModels,
    staleModels: defaults.models.filter((m) => !catalogModels.includes(m)),
  };
}

/**
 * Where a gateway's management API is, with its admin key: null when none
 * is stored (or it was sealed for another type or URL), or the gateway's
 * type has no managed keys.
 */
export function gatewayAdminOf(row: ModelProviderRow): GatewayAdmin | null {
  const type = modelGatewayTypeOf(row.gatewayType);
  if (!modelGatewayCapabilities(type).managedKeys) return null;
  const adminKey = adminKeyOf(row);
  if (!adminKey) return null;
  return { type, base: adminBaseOf(row), adminKey };
}

/** The gateway's id for a key Optio made: its own id, else the hash it names keys by (LiteLLM). */
export function gatewayKeyIdOf(row: Pick<IssuedRow, "gatewayKeyId" | "keyHash">): string {
  return row.gatewayKeyId ?? row.keyHash;
}

/** The organization's gateway `providerId`, for an admin of its workspace. */
async function requireOrgGateway(
  providerId: string,
  actor: Pick<KeyActor, "workspaceId" | "isAdmin">,
): Promise<ModelProviderRow> {
  const row = /^[0-9a-f-]{36}$/i.test(providerId) ? await getModelProviderRow(providerId) : null;
  if (!row || (row.workspaceId ?? null) !== (actor.workspaceId ?? null)) {
    throw new GatewayKeyError("Model provider not found", 404);
  }
  if (row.kind !== "gateway") throw new GatewayKeyError(`"${row.name}" isn't a model gateway`);
  if (row.ownerUserId) {
    throw new GatewayKeyError("Optio makes keys on the organization's gateway, not a personal one");
  }
  if (!actor.isAdmin) {
    throw new GatewayKeyError("Only admins choose how people get gateway tokens", 403);
  }
  return row;
}

/** `GET /api/model-providers/:id/key-issuing` (admins). */
export async function getKeyIssuing(
  providerId: string,
  actor: Pick<KeyActor, "workspaceId" | "isAdmin">,
): Promise<KeyIssuingSettings> {
  return keyIssuingOf(await requireOrgGateway(providerId, actor));
}

export interface KeyIssuingInput {
  modes?: Partial<GatewayKeyModes>;
  /** A new admin key; null clears it; absent keeps it. */
  adminKey?: string | null;
  defaults?: Partial<GatewayKeyDefaults>;
}

const MAX_BUDGET_USD = 1_000_000_000;

function cleanAmount(v: unknown, what: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_BUDGET_USD) {
    throw new GatewayKeyError(`${what} must be an amount in USD, 0 or more`);
  }
  return Math.round(n * 100) / 100;
}

function cleanDuration(v: unknown, what: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !isValidGatewayDuration(v)) {
    throw new GatewayKeyError(`${what} must be a number and s, m, h, d, w or mo, like 30d or 1mo`);
  }
  return v.trim();
}

/**
 * The defaults after `patch`, checked: amounts, durations, models the
 * catalog serves. A model already picked that the catalog stopped serving
 * may stay (new keys leave it out), so saving other fields never fails on
 * it; a new pick must be in the catalog.
 */
export function mergeKeyDefaults(
  current: GatewayKeyDefaults,
  patch: Partial<GatewayKeyDefaults> | undefined,
  catalog: string[],
  type: ModelGatewayType = "litellm",
): GatewayKeyDefaults {
  const next = { ...current };
  if (!patch) return next;
  if ("maxBudget" in patch) next.maxBudget = cleanAmount(patch.maxBudget, "A person's budget");
  if ("budgetDuration" in patch) {
    const period = cleanDuration(patch.budgetDuration, "The budget period");
    next.budgetDuration = type === "litellm" ? period : gatewayBudgetPeriodFor(type, period);
  }
  if ("keyDuration" in patch) next.keyDuration = cleanDuration(patch.keyDuration, "The key's life");
  if ("models" in patch) {
    const models = [...new Set((patch.models ?? []).map((m) => String(m).trim()).filter(Boolean))];
    if (models.length && !modelGatewayCapabilities(type).keyModels) {
      throw new GatewayKeyError(
        `${modelGatewayTypeInfo(type).label} keys can't be limited to some models; every key may call the whole catalog`,
      );
    }
    const unknown = models.filter((m) => !catalog.includes(m) && !current.models.includes(m));
    if (unknown.length) {
      throw new GatewayKeyError(
        `Not in the gateway's catalog: ${unknown.join(", ")} (sync the catalog, or pick from it)`,
      );
    }
    next.models = models;
  }
  return next;
}

const DEFAULT_FIELDS: Array<keyof GatewayKeyDefaults> = [
  "maxBudget",
  "budgetDuration",
  "models",
  "keyDuration",
];

/**
 * `PUT /api/model-providers/:id/key-issuing` (admins): the modes, the admin
 * key and the defaults. Optio-made keys need a type with managed keys, a
 * gateway where each person has their own token (`tokenSource: personal`)
 * and an admin key; a new admin key is tried against the gateway (LiteLLM
 * `/key/list`, OpenRouter `/keys`) and kept either way.
 */
export async function saveKeyIssuing(
  providerId: string,
  input: KeyIssuingInput,
  actor: Pick<KeyActor, "workspaceId" | "isAdmin" | "userId">,
): Promise<{
  settings: KeyIssuingSettings;
  adminKeyTest: { ok: boolean; error?: string } | null;
  changed: string[];
}> {
  const row = await requireOrgGateway(providerId, actor);
  const current = keyIssuingOf(row);
  const modes: GatewayKeyModes = { ...current.modes, ...(input.modes ?? {}) };
  if (!modes.personalPasted && !modes.optioIssued) {
    throw new GatewayKeyError("Leave people at least one way to get a token");
  }
  if (modes.optioIssued && !current.capabilities.managedKeys) {
    throw new GatewayKeyError(
      `Optio doesn't make keys on ${modelGatewayTypeInfo(row.gatewayType).label} gateways; people paste their own`,
    );
  }
  if (modes.optioIssued && row.tokenSource === "stored") {
    throw new GatewayKeyError(
      "This gateway gives every run one shared token; Optio makes keys only where each person has their own",
    );
  }
  const newKey = typeof input.adminKey === "string" ? input.adminKey.trim() : undefined;
  if (newKey !== undefined && (!newKey || newKey.length > 4096)) {
    throw new GatewayKeyError("The admin key is empty");
  }
  if (newKey && !current.capabilities.managedKeys) {
    throw new GatewayKeyError(
      `Optio doesn't make keys on ${modelGatewayTypeInfo(row.gatewayType).label} gateways`,
    );
  }
  const hasAdminKey = input.adminKey === null ? false : newKey ? true : current.hasAdminKey;
  if (modes.optioIssued && !hasAdminKey) {
    throw new GatewayKeyError(`Add the ${adminKeyName(row)} so Optio can make keys`);
  }
  const defaults = mergeKeyDefaults(
    current.defaults,
    input.defaults,
    current.catalogModels,
    current.gatewayType,
  );

  const changed: string[] = [];
  if (modes.personalPasted !== current.modes.personalPasted) changed.push("personalPasted");
  if (modes.optioIssued !== current.modes.optioIssued) changed.push("optioIssued");
  if (newKey || input.adminKey === null) changed.push("adminKey");
  for (const f of DEFAULT_FIELDS) {
    if (JSON.stringify(defaults[f]) !== JSON.stringify(current.defaults[f])) changed.push(f);
  }

  const updates: Partial<typeof modelProviders.$inferInsert> = {
    keyModes: modes,
    keyDefaults: defaults as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  };
  if (input.adminKey === null) {
    Object.assign(updates, CLEARED_ADMIN_KEY);
  } else if (newKey) {
    const blob = encrypt(newKey, adminKeyAAD(row));
    updates.encryptedAdminKey = blob.ciphertext;
    updates.adminKeyIv = blob.iv;
    updates.adminKeyAuthTag = blob.authTag;
  }
  const [saved] = await db
    .update(modelProviders)
    .set(updates)
    .where(eq(modelProviders.id, row.id))
    .returning();
  const adminKeyTest = newKey
    ? await keyDriver({
        type: current.gatewayType,
        base: adminBaseOf(row),
        adminKey: newKey,
      }).check()
    : null;
  if (changed.length) {
    // Field names only: never the admin key.
    record(actor, "model_provider.key_issuing", row.workspaceId, { id: row.id, fields: changed });
  }
  return { settings: keyIssuingOf(saved), adminKeyTest, changed };
}

// ── Keys: the shared steps ───────────────────────────────────────────────────

export interface IssuedKeyView {
  id: string;
  keyAlias: string | null;
  /** The key's last four characters. */
  keyHint: string | null;
  models: string[];
  maxBudget: number | null;
  budgetDuration: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** What the gateway said at the last check (null = not checked yet). */
  spendUsd: number | null;
  budgetResetAt: string | null;
  checkedAt: string | null;
}

function num(v: string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function issuedKeyView(row: IssuedRow): IssuedKeyView {
  return {
    id: row.id,
    keyAlias: row.keyAlias,
    keyHint: row.keyHint,
    models: row.models ?? [],
    maxBudget: num(row.maxBudget),
    budgetDuration: row.budgetDuration,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    spendUsd: num(row.spendUsd),
    budgetResetAt: row.budgetResetAt?.toISOString() ?? null,
    checkedAt: row.checkedAt?.toISOString() ?? null,
  };
}

/**
 * The organization gateway a person's key is about: the one named (it must
 * be the viewer's workspace's and the organization's), else the workspace's
 * default.
 */
async function personalKeyGateway(
  viewer: Pick<KeyActor, "workspaceId" | "userId" | "isAdmin">,
  providerId: string | null | undefined,
): Promise<ModelProviderRow | null> {
  if (!providerId) return defaultGateway(viewer.workspaceId);
  const row = /^[0-9a-f-]{36}$/i.test(providerId) ? await getModelProviderRow(providerId) : null;
  if (!row || row.kind !== "gateway" || !canSeeProvider(row, viewer)) {
    throw new GatewayKeyError("Model provider not found", 404);
  }
  if (row.ownerUserId) {
    throw new GatewayKeyError("Optio makes keys on the organization's gateway, not a personal one");
  }
  return row;
}

interface IssuingContext {
  row: ModelProviderRow;
  settings: KeyIssuingSettings;
  admin: GatewayAdmin;
  driver: GatewayKeyDriver;
  /**
   * What a new key may call: the defaults' models, else the whole catalog;
   * empty where the gateway can't limit a key's models.
   */
  models: string[];
}

/** A gateway ready to make keys, or the reason it isn't. */
function issuingContext(row: ModelProviderRow): IssuingContext {
  const settings = keyIssuingOf(row);
  if (!settings.modes.optioIssued) {
    throw new GatewayKeyError(
      `${row.name} doesn't make keys; an admin turns that on under Settings → Model gateway`,
    );
  }
  const admin = gatewayAdminOf(row);
  if (!admin) {
    throw new GatewayKeyError(
      `An admin hasn't stored the ${adminKeyName(row)} for ${row.name} yet (Settings → Model gateway)`,
    );
  }
  const driver = keyDriver(admin);
  if (!settings.capabilities.keyModels) return { row, settings, admin, driver, models: [] };
  // LiteLLM reads an empty list as "every model", more than the admin allowed:
  // a key always names its models.
  const picked = settings.defaults.models.filter((m) => !settings.staleModels.includes(m));
  if (settings.defaults.models.length && !picked.length) {
    throw new GatewayKeyError(
      `None of the models an admin picked for keys on ${row.name} is in its catalog now ` +
        `(${settings.staleModels.join(", ")}); an admin picks again under Settings → Model gateway`,
      409,
    );
  }
  const models = picked.length ? picked : settings.catalogModels;
  if (!models.length) {
    throw new GatewayKeyError(
      `${row.name}'s catalog is empty: an admin syncs it before Optio makes keys`,
      409,
    );
  }
  return { row, settings, admin, driver, models };
}

/**
 * A new key on the gateway, the alias freed first when a key is being
 * replaced on a gateway that wants aliases unique (LiteLLM): the old key
 * takes `<alias>-rotated-<time>`, and an alias someone else's key holds gets
 * a short suffix.
 */
async function generateWithAlias(
  driver: GatewayKeyDriver,
  input: GenerateKeyInput,
  replacing: IssuedRow | null,
): Promise<GeneratedKey> {
  if (driver.renameKey && replacing?.keyAlias === input.keyAlias) {
    await driver
      .renameKey(gatewayKeyIdOf(replacing), `${input.keyAlias}-rotated-${Date.now().toString(36)}`)
      .catch((err) =>
        logger.warn({ err: String(err) }, "gateway key: couldn't rename the key being replaced"),
      );
  }
  try {
    return await driver.generateKey(input);
  } catch (err) {
    if (!isAliasTaken(err)) throw err;
    return driver.generateKey({
      ...input,
      keyAlias: `${input.keyAlias}-${randomBytes(2).toString("hex")}`,
    });
  }
}

/**
 * What the gateway says a key spent this period and of what, as a budget:
 * where a replaced key's spend is carried as a lower limit (OpenRouter), the
 * amounts still running are added back, so the spend and the budget read
 * the same on every gateway.
 */
export async function keySpendOf(
  driver: GatewayKeyDriver,
  row: Pick<IssuedRow, "gatewayKeyId" | "keyHash" | "carriedSpend" | "maxBudget">,
  now = new Date(),
): Promise<GatewaySpend | null> {
  const live = await driver.keySpend(gatewayKeyIdOf(row));
  if (!live || driver.carry !== "limit") return live;
  const carried = carriedTotal(
    carriedOf(row.carriedSpend).filter(
      (p) => p.until === null || new Date(p.until).getTime() > now.getTime(),
    ),
  );
  const budget = num(row.maxBudget);
  return {
    ...live,
    spend: Math.round((live.spend + carried) * 1e6) / 1e6,
    maxBudget: budget ?? (live.maxBudget === null ? null : live.maxBudget + carried),
  };
}

/** What the gateway says a key spent, in the terms `carryAfter` reads it (LiteLLM's). */
async function carrySpendOf(
  driver: GatewayKeyDriver,
  row: IssuedRow,
  now = new Date(),
): Promise<GatewaySpend | null> {
  const live = await driver.keySpend(gatewayKeyIdOf(row));
  if (!live || driver.carry !== "limit") return live;
  return {
    ...live,
    spend: Math.round((live.spend + carriedInSpend(row, now)) * 1e6) / 1e6,
  };
}

/**
 * The value in the person's gateway token now (null = none). Any failure
 * (the database, a value that won't decrypt) throws: a key must never be
 * taken for "replaced" and deleted on the gateway because a read failed once.
 */
export async function keySecretValue(row: IssuedRow): Promise<string | null> {
  if (!row.userId) return null;
  const found = await retrieveGatewayTokenSecret(
    gatewayTokenSecretName(row.providerId),
    "user",
    null,
    row.userId,
  );
  return found?.value ?? null;
}

/** Whether the person's token still holds this key (they may have pasted another since). */
async function secretHolds(row: IssuedRow): Promise<boolean> {
  const value = await keySecretValue(row);
  return value !== null && keyValueHash(value) === row.keyHash;
}

/** Remove the person's token when it still holds this key. */
async function removeKeySecret(row: IssuedRow): Promise<void> {
  if (!row.userId || !(await secretHolds(row))) return;
  await deleteSecret(gatewayTokenSecretName(row.providerId), "user", null, row.userId);
}

/**
 * Take a key out of use: blocked (spend kept on the gateway) or deleted
 * there, its token removed when it still holds this key, the row marked
 * revoked. A gateway or database failure throws and leaves the row active,
 * so the housekeeping check tries again (blocking and deleting are safe to
 * repeat). The token is read before the gateway is touched, so a failing
 * read stops before anything that can't be undone.
 */
export async function retireKey(
  row: IssuedRow,
  how: "block" | "delete",
  reason: string,
  admin?: GatewayAdmin | null,
): Promise<void> {
  const conn =
    admin === undefined
      ? await getModelProviderRow(row.providerId).then((p) => (p ? gatewayAdminOf(p) : null))
      : admin;
  const driver = conn ? keyDriver(conn) : null;
  // What it spent this period, read before it goes, so the key that follows
  // starts from there (spendToCarry).
  const last = driver ? await carrySpendOf(driver, row).catch(() => null) : null;
  await keySecretValue(row);
  if (driver) {
    if (how === "block") await driver.blockKey(gatewayKeyIdOf(row));
    else await driver.deleteKeys([gatewayKeyIdOf(row)]);
  } else {
    logger.warn(
      { keyId: row.id, alias: row.keyAlias },
      "gateway key: no admin key stored; marked revoked in Optio only (block it on the gateway)",
    );
  }
  await removeKeySecret(row);
  await db
    .update(gatewayIssuedKeys)
    .set({
      status: "revoked",
      revokedReason: reason,
      revokedAt: new Date(),
      updatedAt: new Date(),
      ...(last
        ? {
            spendUsd: String(last.spend),
            budgetResetAt: last.budgetResetAt ? new Date(last.budgetResetAt) : null,
          }
        : {}),
    })
    .where(eq(gatewayIssuedKeys.id, row.id));
}

/**
 * One key-making at a time per person and gateway, across instances (a
 * double click, two tabs): a lease, so a second request is refused, never
 * left to make a second key.
 */
async function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let ran = false;
  const out = await withLease(
    key,
    async () => {
      ran = true;
      return fn();
    },
    // A holder of its own: the instance's id would let this instance's
    // second request in.
    { ttlMs: 60_000, holder: `gateway-key:${randomBytes(8).toString("hex")}` },
  );
  if (!ran) throw new GatewayKeyError("Optio is already making this key", 409);
  return out as T;
}

// ── A person's key ───────────────────────────────────────────────────────────

async function activePersonKey(providerId: string, userId: string): Promise<IssuedRow | null> {
  const [row] = await db
    .select()
    .from(gatewayIssuedKeys)
    .where(
      and(
        eq(gatewayIssuedKeys.providerId, providerId),
        eq(gatewayIssuedKeys.userId, userId),
        eq(gatewayIssuedKeys.status, "active"),
      ),
    )
    .orderBy(desc(gatewayIssuedKeys.createdAt))
    .limit(1);
  return row ?? null;
}

/** The person's most recent key on the gateway, whatever its status. */
async function latestKey(providerId: string, userId: string): Promise<IssuedRow | null> {
  const [row] = await db
    .select()
    .from(gatewayIssuedKeys)
    .where(and(eq(gatewayIssuedKeys.providerId, providerId), eq(gatewayIssuedKeys.userId, userId)))
    .orderBy(desc(gatewayIssuedKeys.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * What a person's new key carries over (gateway-key-carry.ts): the amounts
 * their last key on the gateway carried that are still running, plus what
 * that key spent itself while its period runs. That key is the one being
 * rotated (its spend read live) or else the last one they gave up or lost
 * (the spend saved when it went). Without this, "Rotate", or "Give up" then
 * "Get my token", would start the budget over. Each amount carries only
 * until its own key's period ends; the housekeeping check then takes it off,
 * so spend never piles up across rotations.
 */
export async function spendToCarry(
  admin: GatewayAdmin,
  providerId: string,
  userId: string,
  now = new Date(),
): Promise<CarriedSpend[]> {
  const driver = keyDriver(admin);
  const last = await latestKey(providerId, userId);
  if (!last || last.maxBudget === null) return [];
  if (last.status === "active") {
    const live = await carrySpendOf(driver, last, now).catch(() => null);
    if (live) {
      return carryAfter(
        last,
        { spend: live.spend, resetAt: live.budgetResetAt ?? last.budgetResetAt, readAt: now },
        now,
      );
    }
  }
  const readAt = last.revokedAt ?? last.checkedAt ?? last.createdAt;
  return carryAfter(
    last,
    { spend: num(last.spendUsd) ?? 0, resetAt: last.budgetResetAt, readAt },
    now,
  );
}

export interface MyGatewayKeyStatus {
  gateway: { id: string; name: string; type: ModelGatewayType } | null;
  modes: GatewayKeyModes;
  /** "Get my token" works now: Optio makes keys and holds the admin key. */
  canIssue: boolean;
  issued: IssuedKeyView | null;
  defaults: Pick<GatewayKeyDefaults, "maxBudget" | "budgetDuration" | "keyDuration">;
}

/** `GET /api/gateway/me/key`: how the viewer gets a token, and the key Optio made them. */
export async function myGatewayKeyStatus(
  viewer: Pick<KeyActor, "workspaceId" | "userId" | "isAdmin">,
  providerId?: string | null,
): Promise<MyGatewayKeyStatus> {
  const row = await personalKeyGateway(viewer, providerId);
  const settings = row ? keyIssuingOf(row) : null;
  const modes = settings?.modes ?? gatewayKeyModesOf(null);
  const issued = row && viewer.userId ? await activePersonKey(row.id, viewer.userId) : null;
  const d = settings?.defaults ?? gatewayKeyDefaultsOf(null);
  return {
    gateway: row ? { id: row.id, name: row.name, type: modelGatewayTypeOf(row.gatewayType) } : null,
    modes,
    canIssue: !!row && !!viewer.userId && modes.optioIssued && !!settings?.hasAdminKey,
    issued: issued ? issuedKeyView(issued) : null,
    defaults: {
      maxBudget: d.maxBudget,
      budgetDuration: d.budgetDuration,
      keyDuration: d.keyDuration,
    },
  };
}

export interface IssueResult {
  action: "issue" | "rotate";
  key: IssuedKeyView;
  test: GatewayTestResult;
}

/**
 * "Get my token" / "Rotate" (`POST /api/gateway/me/key[/rotate]`): a new key
 * on the gateway for the viewer, stored as their gateway token; the key it
 * replaces is deleted there. `rotate` insists there is one to replace. The
 * budget, period, expiry and models are the admin's, never the caller's.
 */
export async function issuePersonalKey(
  viewer: Pick<KeyActor, "workspaceId" | "userId" | "isAdmin">,
  opts: { rotate?: boolean; providerId?: string | null } = {},
): Promise<IssueResult> {
  const userId = viewer.userId;
  if (!userId) throw new GatewayKeyError("Sign in to get your own gateway token", 403);
  const gateway = await personalKeyGateway(viewer, opts.providerId);
  if (!gateway) throw new GatewayKeyError("The workspace has no model gateway yet", 404);
  const ctx = issuingContext(gateway);
  return once(`gateway-key:${ctx.row.id}:${userId}`, async () => {
    const old = await activePersonKey(ctx.row.id, userId);
    if (opts.rotate && !old) {
      throw new GatewayKeyError("You have no key Optio made to rotate; get one first", 404);
    }
    const [person] = await db
      .select({ email: users.email, name: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    if (!person) throw new GatewayKeyError("Sign in to get your own gateway token", 403);
    const d = ctx.settings.defaults;
    const litellmUser = person.email?.trim().toLowerCase() || `optio-user-${userId}`;
    // Read before the old key is touched: what it spent this period carries over.
    const carry = d.maxBudget !== null ? await spendToCarry(ctx.admin, ctx.row.id, userId) : [];
    const carried = carriedTotal(carry);
    const budgetDuration = d.maxBudget !== null ? d.budgetDuration : null;
    let made: GeneratedKey;
    try {
      made = await generateWithAlias(
        ctx.driver,
        {
          keyAlias: personalGatewayKeyAlias(person),
          userId: litellmUser,
          models: ctx.models,
          maxBudget: d.maxBudget,
          budgetDuration,
          duration: d.keyDuration,
          spend: carried,
          metadata: {
            optio_user_id: userId,
            optio_gateway_id: ctx.row.id,
            ...(viewer.workspaceId ? { optio_workspace_id: viewer.workspaceId } : {}),
            made_by: "optio",
          },
        },
        old,
      );
    } catch (err) {
      fromGateway(err);
    }
    try {
      await writeGatewayToken(ctx.row, { userId }, made.key);
    } catch (err) {
      // Never leave a key on the gateway that nobody holds.
      await ctx.driver.deleteKeys([made.keyId ?? made.keyHash]).catch(() => {});
      throw err;
    }
    const [saved] = await db
      .insert(gatewayIssuedKeys)
      .values({
        workspaceId: ctx.row.workspaceId,
        providerId: ctx.row.id,
        userId,
        keyHash: made.keyHash,
        gatewayKeyId: made.keyId ?? null,
        keyAlias: made.keyAlias,
        keyHint: keyHint(made.key),
        litellmUserId: ctx.driver.type === "litellm" ? litellmUser : null,
        models: ctx.models,
        maxBudget: d.maxBudget === null ? null : String(d.maxBudget),
        budgetDuration,
        expiresAt: made.expiresAt ?? durationEnd(d.keyDuration),
        spendUsd: carried > 0 ? String(carried) : null,
        carriedSpend: carry.length ? carry : null,
        createdBy: userId,
      })
      .returning();
    if (old) {
      await retireKey(old, "delete", "rotated", ctx.admin).catch((err) =>
        logger.warn(
          { err: String(err), keyId: old.id },
          "gateway key: the replaced key is left for the housekeeping check to delete",
        ),
      );
    }
    const action = old ? "rotate" : "issue";
    record(viewer, `gateway_key.${action}`, ctx.row.workspaceId, {
      id: ctx.row.id,
      keyAlias: made.keyAlias,
      maxBudget: d.maxBudget,
      budgetDuration,
    });
    return { action, key: issuedKeyView(saved), test: await gatewayTest(ctx.row, made.key) };
  });
}

/** `DELETE /api/gateway/me/key`: the viewer gives up the key Optio made them (deleted on the gateway). */
export async function revokePersonalKey(
  viewer: Pick<KeyActor, "workspaceId" | "userId" | "isAdmin">,
  providerId?: string | null,
): Promise<{ revoked: number }> {
  if (!viewer.userId) throw new GatewayKeyError("Sign in first", 403);
  const row = await personalKeyGateway(viewer, providerId);
  const key = row ? await activePersonKey(row.id, viewer.userId) : null;
  if (!row || !key) throw new GatewayKeyError("You have no key Optio made", 404);
  try {
    await retireKey(key, "delete", "revoked by its owner", gatewayAdminOf(row));
  } catch (err) {
    fromGateway(err);
  }
  record(viewer, "gateway_key.revoke", row.workspaceId, {
    id: row.id,
    keyAlias: key.keyAlias,
    reason: "revoked by its owner",
  });
  return { revoked: 1 };
}

/**
 * Block every key Optio made for `userId` (in one workspace's gateways, or
 * everywhere) on the gateway and remove the token from their secrets. Never
 * throws; answers how many were revoked and how many couldn't be (the
 * housekeeping check retries those). Removing a member calls it.
 */
export async function revokeIssuedGatewayKeys(
  userId: string,
  opts: { workspaceId?: string | null; reason?: string } = {},
): Promise<{ revoked: number; failed: number }> {
  const reason = opts.reason ?? "deactivated";
  let revoked = 0;
  let failed = 0;
  try {
    const rows = await db
      .select()
      .from(gatewayIssuedKeys)
      .where(
        and(
          eq(gatewayIssuedKeys.userId, userId),
          eq(gatewayIssuedKeys.status, "active"),
          ...(opts.workspaceId ? [eq(gatewayIssuedKeys.workspaceId, opts.workspaceId)] : []),
        ),
      );
    for (const row of rows) {
      try {
        await retireKey(row, "block", reason);
        revoked++;
        record(null, "gateway_key.revoke", row.workspaceId, {
          id: row.providerId,
          targetUserId: userId,
          keyAlias: row.keyAlias,
          reason,
        });
      } catch (err) {
        failed++;
        logger.warn(
          { err: String(err), keyId: row.id },
          "gateway key: couldn't block it on the gateway",
        );
      }
    }
  } catch (err) {
    logger.warn({ err: String(err), userId }, "gateway key: revoking a person's keys failed");
  }
  return { revoked, failed };
}

// ── Admins: the keys on a gateway ────────────────────────────────────────────

export interface IssuedKeyAdminView extends IssuedKeyView {
  user: { id: string; name: string | null; email: string | null } | null;
}

/** `GET /api/model-providers/:id/keys` (admins): the active keys Optio made on the gateway. */
export async function listIssuedKeys(
  providerId: string,
  actor: Pick<KeyActor, "workspaceId" | "isAdmin">,
): Promise<IssuedKeyAdminView[]> {
  const row = await requireOrgGateway(providerId, actor);
  const rows = await db
    .select({ key: gatewayIssuedKeys, name: users.displayName, email: users.email })
    .from(gatewayIssuedKeys)
    .leftJoin(users, eq(users.id, gatewayIssuedKeys.userId))
    .where(and(eq(gatewayIssuedKeys.providerId, row.id), eq(gatewayIssuedKeys.status, "active")))
    .orderBy(desc(gatewayIssuedKeys.createdAt));
  return rows.map((r) => ({
    ...issuedKeyView(r.key),
    user: r.key.userId ? { id: r.key.userId, name: r.name, email: r.email } : null,
  }));
}

/** `DELETE /api/model-providers/:id/keys/:keyId` (admins): block one key Optio made. */
export async function adminRevokeKey(
  providerId: string,
  keyId: string,
  actor: Pick<KeyActor, "workspaceId" | "isAdmin" | "userId">,
): Promise<{ revoked: number }> {
  const row = await requireOrgGateway(providerId, actor);
  const [key] = await db
    .select()
    .from(gatewayIssuedKeys)
    .where(
      and(
        eq(gatewayIssuedKeys.id, keyId),
        eq(gatewayIssuedKeys.providerId, row.id),
        eq(gatewayIssuedKeys.status, "active"),
      ),
    );
  if (!key) throw new GatewayKeyError("No such key", 404);
  try {
    await retireKey(key, "block", "revoked by an admin", gatewayAdminOf(row));
  } catch (err) {
    fromGateway(err);
  }
  record(actor, "gateway_key.revoke", row.workspaceId, {
    id: row.id,
    targetUserId: key.userId,
    keyAlias: key.keyAlias,
    reason: "revoked by an admin",
  });
  return { revoked: 1 };
}

/** How many keys Optio made are active on a gateway (a URL or type change is refused while any are). */
export async function activeIssuedKeyCount(providerId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(gatewayIssuedKeys)
    .where(
      and(eq(gatewayIssuedKeys.providerId, providerId), eq(gatewayIssuedKeys.status, "active")),
    );
  return row?.n ?? 0;
}

/**
 * Before a gateway is deleted: delete the keys Optio made on it, there, and
 * their tokens. Answers a refusal when that can't be done (no readable admin
 * key, the gateway refuses), unless `force`: then the keys are marked
 * revoked in Optio and stay on the gateway until someone deletes them there.
 */
export async function revokeProviderKeys(
  providerId: string,
  actor: Pick<KeyActor, "workspaceId" | "isAdmin" | "userId">,
  opts: { force?: boolean } = {},
): Promise<{ revoked: number; refusal: string | null }> {
  const provider = /^[0-9a-f-]{36}$/i.test(providerId)
    ? await getModelProviderRow(providerId)
    : null;
  if (!provider || provider.kind !== "gateway") return { revoked: 0, refusal: null };
  if ((provider.workspaceId ?? null) !== (actor.workspaceId ?? null)) {
    return { revoked: 0, refusal: null };
  }
  const rows = await db
    .select()
    .from(gatewayIssuedKeys)
    .where(
      and(eq(gatewayIssuedKeys.providerId, providerId), eq(gatewayIssuedKeys.status, "active")),
    );
  if (!rows.length) return { revoked: 0, refusal: null };
  const label = modelGatewayTypeInfo(provider.gatewayType).label;
  let problem: string | null = null;
  const admin = gatewayAdminOf(provider);
  if (admin) {
    try {
      await keyDriver(admin).deleteKeys(rows.map((r) => gatewayKeyIdOf(r)));
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  } else {
    problem = `Optio holds no ${adminKeyName(provider)} for it`;
  }
  if (problem && !opts.force) {
    return {
      revoked: 0,
      refusal:
        `Optio couldn't delete the ${rows.length} key${rows.length === 1 ? "" : "s"} it made on ` +
        `${provider.name} in ${label} (${problem}). Fix that and delete it again, or delete it ` +
        `anyway: those keys then stay in ${label} until someone deletes them there.`,
    };
  }
  const reason = problem ? `gateway removed; still in ${label}` : "gateway removed";
  for (const row of rows) {
    await removeKeySecret(row).catch((err) =>
      logger.warn({ err: String(err), keyId: row.id }, "gateway key: couldn't remove its token"),
    );
  }
  await db
    .update(gatewayIssuedKeys)
    .set({ status: "revoked", revokedReason: reason, revokedAt: new Date(), updatedAt: new Date() })
    .where(
      inArray(
        gatewayIssuedKeys.id,
        rows.map((r) => r.id),
      ),
    );
  record(actor, "gateway_key.revoke", provider.workspaceId, {
    id: providerId,
    keys: rows.length,
    reason,
  });
  return { revoked: rows.length, refusal: null };
}
