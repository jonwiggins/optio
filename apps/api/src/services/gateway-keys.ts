import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  gatewayBudgetPeriodFor,
  gatewayBudgetProblem,
  gatewayKeyAliasPart,
  gatewayKeyDefaultsOf,
  gatewayKeyModesOf,
  isValidGatewayDuration,
  modelGatewayCapabilities,
  modelGatewayTypeInfo,
  modelGatewayTypeOf,
  personalGatewayKeyAlias,
  teamGatewayKeyAlias,
  type GatewayKeyDefaults,
  type GatewayKeyModes,
  type ModelGatewayCapabilities,
  type ModelGatewayType,
} from "@optio/shared";
import { db } from "../db/client.js";
import { gatewayIssuedKeys, modelProviders, teams, users } from "../db/schema.js";
import { logger } from "../logger.js";
import { auditEvent } from "./audit.js";
import { LiteLLMError, isAliasTaken, isTeamMissing } from "./litellm-admin.js";
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
  defaultGateway,
  gatewayTest,
  tokenSecretNameOf,
  type GatewayTestResult,
} from "./model-gateway-service.js";
import { gatewayOf, getModelProviderRow, type ModelProviderRow } from "./model-provider-service.js";
import type { Actor } from "./ownership.js";
import { decrypt, deleteSecret, encrypt, retrieveSecret, storeSecret } from "./secret-service.js";
import {
  carriedInSpend,
  carriedOf,
  carriedTotal,
  carryAfter,
  durationEnd,
  type CarriedSpend,
} from "./gateway-key-carry.js";

export { budgetPeriodOpen, durationEnd } from "./gateway-key-carry.js";

/**
 * Gateway keys made by Optio, and team budgets (docs/model-gateway.md "Keys
 * Optio makes"). The routes are `routes/gateway-keys.ts`, the housekeeping
 * check (deactivation, budget warnings) `gateway-key-check.ts`, and each
 * gateway type's key API a driver (`gateway-admin.ts`: LiteLLM, OpenRouter,
 * Portkey).
 *
 * Per gateway an admin chooses how people get a token: pasted by hand, made
 * by Optio on the gateway, or both (where the gateway's type has managed
 * keys). Optio makes keys with the admin key sealed on the gateway row:
 *
 * - a person's: alias `optio-<user>`, the gateway's budget, budget period
 *   and expiry (and on LiteLLM their email as `user_id` and the catalog's
 *   models) — stored exactly where a pasted token goes (their own secret
 *   named by the gateway), so a run finds it the same way;
 * - a team's: on LiteLLM a LiteLLM team (`POST /team/new`, its budget shared
 *   by its keys) and a key bound to it; elsewhere one key whose own limit is
 *   the team's budget. Stored as the team's gateway secret.
 *
 * "Rotate" makes a new key and deletes the old one on the gateway (Portkey
 * gives the same key a new value). A key whose person leaves the workspace,
 * or is deleted or disabled, is blocked on the gateway
 * (`revokeIssuedGatewayKeys`, which the offboarding code calls too).
 * `gateway_issued_keys` remembers the SHA-256 of each key's value and the
 * gateway's id for it, never the value.
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
export type KeyActor = Pick<
  Actor,
  "userId" | "workspaceId" | "isAdmin" | "teamIds" | "adminTeamIds"
>;

/** Where an audit entry comes from: a request, or Optio itself (`userId` null). */
export interface AuditFrom {
  req?: FastifyRequest | null;
}

function audit(
  from: AuditFrom | undefined,
  action: string,
  workspaceId: string | null,
  details: Record<string, unknown>,
) {
  void auditEvent({
    req: from?.req ?? null,
    ...(from?.req ? {} : { userId: null }),
    workspaceId,
    action,
    details,
  });
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

function adminKeyAAD(providerId: string): Buffer {
  return Buffer.from(`model_provider_admin_key|${providerId}`);
}

/** What the gateway's type calls the key Optio makes keys with ("LiteLLM admin key"). */
function adminKeyName(row: Pick<ModelProviderRow, "gatewayType">): string {
  return modelGatewayTypeInfo(row.gatewayType).adminKeyName ?? "admin key";
}

/** How the gateway is named where a message says where a key lives ("LiteLLM"). */
function gatewayLabelOf(row: Pick<ModelProviderRow, "gatewayType">): string {
  return modelGatewayTypeInfo(row.gatewayType).label;
}

/** The gateway's admin key sealed on a gateway, or null. */
export function adminKeyOf(row: ModelProviderRow): string | null {
  if (!row.encryptedAdminKey || !row.adminKeyIv || !row.adminKeyAuthTag) return null;
  return decrypt(
    {
      alg: 1,
      iv: row.adminKeyIv,
      ciphertext: row.encryptedAdminKey,
      authTag: row.adminKeyAuthTag,
    },
    adminKeyAAD(row.id),
    `the ${adminKeyName(row)} of ${row.name}`,
  );
}

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
  hasAdminKey: boolean;
  /** What "every model" means for a key: the catalog's ids. */
  catalogModels: string[];
  /**
   * Models in `defaults.models` the catalog no longer serves (a sync flagged
   * them missing, or they left it): new keys leave them out, and the admin
   * sees them flagged so they can untick them.
   */
  staleModels: string[];
}

/**
 * The stored defaults as the gateway's type takes them: budget periods it
 * doesn't take become the nearest it does, and no models where a key can't
 * be limited to some (LiteLLM's are kept as stored).
 */
function defaultsForType(type: ModelGatewayType, d: GatewayKeyDefaults): GatewayKeyDefaults {
  if (type === "litellm") return d;
  const caps = modelGatewayCapabilities(type);
  return {
    ...d,
    budgetDuration: gatewayBudgetPeriodFor(type, d.budgetDuration),
    teamBudgetDuration: gatewayBudgetPeriodFor(type, d.teamBudgetDuration),
    models: caps.keyModels ? d.models : [],
  };
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
    // A type without managed keys only ever takes pasted ones.
    modes: capabilities.managedKeys
      ? gatewayKeyModesOf(row.keyModes)
      : { personalPasted: true, optioIssued: false },
    defaults,
    hasAdminKey: !!row.encryptedAdminKey,
    catalogModels,
    staleModels: defaults.models.filter((m) => !catalogModels.includes(m)),
  };
}

/**
 * Where a gateway's management API is, with its admin key: null when none
 * is stored, or the gateway's type has no managed keys.
 */
export function gatewayAdminOf(row: ModelProviderRow): GatewayAdmin | null {
  const type = modelGatewayTypeOf(row.gatewayType);
  if (!modelGatewayCapabilities(type).managedKeys) return null;
  const adminKey = adminKeyOf(row);
  if (!adminKey) return null;
  const workspace = gatewayKeyDefaultsOf(row.keyDefaults).workspace ?? null;
  return { type, base: adminBaseOf(row), adminKey, ...(workspace ? { workspace } : {}) };
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

/** A budget amount the gateway's type takes (Portkey: whole USD, 1 or more). */
function typedAmount(type: ModelGatewayType, v: unknown, what: string): number | null {
  const amount = cleanAmount(v, what);
  const problem = gatewayBudgetProblem(type, amount);
  if (problem) throw new GatewayKeyError(`${what}: ${problem}`);
  return amount;
}

/** A budget period, as the nearest one the gateway's type takes (LiteLLM's as given). */
function typedPeriod(type: ModelGatewayType, v: unknown, what: string): string | null {
  const period = cleanDuration(v, what);
  return type === "litellm" ? period : gatewayBudgetPeriodFor(type, period);
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
 * may stay (the admin unticks it when they like), so saving other fields
 * never fails on it; a new pick must be in the catalog.
 */
export function mergeKeyDefaults(
  current: GatewayKeyDefaults,
  patch: Partial<GatewayKeyDefaults> | undefined,
  catalog: string[],
  type: ModelGatewayType = "litellm",
): GatewayKeyDefaults {
  const next = { ...current };
  if (!patch) return next;
  if ("maxBudget" in patch)
    next.maxBudget = typedAmount(type, patch.maxBudget, "A person's budget");
  if ("budgetDuration" in patch) {
    next.budgetDuration = typedPeriod(type, patch.budgetDuration, "The budget period");
  }
  if ("keyDuration" in patch) next.keyDuration = cleanDuration(patch.keyDuration, "The key's life");
  if ("teamMaxBudget" in patch) {
    next.teamMaxBudget = typedAmount(type, patch.teamMaxBudget, "A team's budget");
  }
  if ("teamBudgetDuration" in patch) {
    next.teamBudgetDuration = typedPeriod(type, patch.teamBudgetDuration, "The team budget period");
  }
  if ("workspace" in patch) {
    const ws = typeof patch.workspace === "string" ? patch.workspace.trim() : "";
    if (ws.length > 200) throw new GatewayKeyError("The workspace id is too long");
    if (ws) next.workspace = ws;
    else delete next.workspace;
  }
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
  "teamMaxBudget",
  "teamBudgetDuration",
  "workspace",
];

/**
 * `PUT /api/model-providers/:id/key-issuing` (admins): the modes, the admin
 * key and the defaults. Optio-made keys need a gateway type with managed
 * keys, a gateway where each person and team has their own token
 * (`tokenSource: personal`) and an admin key; a new admin key is tried
 * against the gateway (LiteLLM `/key/list`, OpenRouter `/keys`, Portkey
 * `/api-keys`) and kept either way.
 */
export async function saveKeyIssuing(
  providerId: string,
  input: KeyIssuingInput,
  actor: Pick<KeyActor, "workspaceId" | "isAdmin">,
  from?: AuditFrom,
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
      `Optio doesn't make keys on ${gatewayLabelOf(row)} gateways; people paste their own`,
    );
  }
  const newKey = typeof input.adminKey === "string" ? input.adminKey.trim() : undefined;
  if (newKey !== undefined && (!newKey || newKey.length > 4096)) {
    throw new GatewayKeyError("The admin key is empty");
  }
  const hasAdminKey = input.adminKey === null ? false : newKey ? true : current.hasAdminKey;
  if (modes.optioIssued && row.tokenSource === "stored") {
    throw new GatewayKeyError(
      "This gateway gives every run one shared token; Optio makes keys only where each person and team has their own",
    );
  }
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
    updates.encryptedAdminKey = null;
    updates.adminKeyIv = null;
    updates.adminKeyAuthTag = null;
  } else if (newKey) {
    const blob = encrypt(newKey, adminKeyAAD(row.id));
    updates.encryptedAdminKey = blob.ciphertext;
    updates.adminKeyIv = blob.iv;
    updates.adminKeyAuthTag = blob.authTag;
  }
  const [saved] = await db
    .update(modelProviders)
    .set(updates)
    .where(eq(modelProviders.id, row.id))
    .returning();
  const adminKeyTest =
    newKey && current.capabilities.managedKeys
      ? await keyDriver({
          type: current.gatewayType,
          base: adminBaseOf(row),
          adminKey: newKey,
          workspace: defaults.workspace ?? null,
        }).check()
      : null;

  if (changed.length) {
    audit(from, "model_provider.key_issuing", row.workspaceId, {
      id: row.id,
      name: row.name,
      fields: changed,
    });
  }
  if (changed.includes("maxBudget") || changed.includes("budgetDuration")) {
    audit(from, "budget.set", row.workspaceId, {
      id: row.id,
      scope: "user",
      maxBudget: defaults.maxBudget,
      budgetDuration: defaults.budgetDuration,
    });
  }
  if (changed.includes("teamMaxBudget") || changed.includes("teamBudgetDuration")) {
    audit(from, "budget.set", row.workspaceId, {
      id: row.id,
      scope: "team",
      maxBudget: defaults.teamMaxBudget,
      budgetDuration: defaults.teamBudgetDuration,
    });
  }
  return { settings: keyIssuingOf(saved), adminKeyTest, changed };
}

/**
 * Why a pasted token for the default gateway can't be stored at `scope`
 * (null = it can): the gateway takes only keys Optio makes. Only people's
 * and teams' tokens are pasted; the organization's is a deployment admin's.
 * The secrets route calls this for any write, so the name decides — the
 * workspace's default gateway's token name, whatever OPTIO_MODEL_ACCESS says
 * (with no gateway, upstream's case, nothing is refused).
 */
export async function pastedTokenRefusal(
  name: string | null,
  scope: string | null | undefined,
  workspaceId: string | null | undefined,
): Promise<string | null> {
  if (scope !== "user" && scope !== "team") return null;
  if (name !== null && !GATEWAY_TOKEN_NAMES.has(name)) return null;
  // A refusal that can't be worked out isn't one: the write goes on (and
  // fails on its own if the database is the trouble).
  let row: ModelProviderRow | null = null;
  try {
    row = await defaultGateway(workspaceId);
  } catch {
    return null;
  }
  if (!row || row.tokenSource !== "personal") return null;
  if (name !== null && tokenSecretNameOf(row) !== name) return null;
  if (keyIssuingOf(row).modes.personalPasted) return null;
  return scope === "team"
    ? `${row.name} takes only keys Optio makes: a team admin presses "Create team key" under Teams → the team → Tokens`
    : `${row.name} takes only keys Optio makes: press "Get my token" under Settings → My tokens`;
}

/** The names a gateway token is stored under (`gatewayTokenSecretName`). */
const GATEWAY_TOKEN_NAMES = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
]);

// ── Keys: the shared steps ───────────────────────────────────────────────────

export interface IssuedKeyView {
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
    kind: row.kind,
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

interface IssuingContext {
  row: ModelProviderRow;
  settings: KeyIssuingSettings;
  admin: GatewayAdmin;
  driver: GatewayKeyDriver;
  secretName: string;
  /**
   * What a new key may call: the defaults' models, else the whole catalog;
   * empty where the gateway can't limit a key's models.
   */
  models: string[];
}

/** The workspace's default gateway, ready to make keys, or the reason it isn't. */
async function issuingContext(workspaceId: string | null): Promise<IssuingContext> {
  const row = await defaultGateway(workspaceId);
  if (!row) throw new GatewayKeyError("The workspace has no model gateway yet", 404);
  const settings = keyIssuingOf(row);
  if (!settings.modes.optioIssued) {
    throw new GatewayKeyError(
      `${row.name} doesn't make keys; an admin turns that on under Settings → Model gateway`,
    );
  }
  if (row.tokenSource !== "personal") {
    throw new GatewayKeyError(`${row.name} gives every run one shared token`);
  }
  const admin = gatewayAdminOf(row);
  if (!admin) {
    throw new GatewayKeyError(
      `An admin hasn't stored the ${adminKeyName(row)} for ${row.name} yet (Settings → Model gateway)`,
    );
  }
  const driver = keyDriver(admin);
  if (!settings.capabilities.keyModels) {
    return { row, settings, admin, driver, secretName: tokenSecretNameOf(row), models: [] };
  }
  // The admin's picks the catalog still serves. All of them gone would mean
  // "every model" to LiteLLM (an empty list), more than the admin allowed.
  const picked = settings.defaults.models.filter((m) => !settings.staleModels.includes(m));
  if (settings.defaults.models.length && !picked.length) {
    throw new GatewayKeyError(
      `None of the models an admin picked for keys on ${row.name} is in its catalog now ` +
        `(${settings.staleModels.join(", ")}); an admin picks again under Settings → Model gateway → How people get tokens`,
      409,
    );
  }
  return {
    row,
    settings,
    admin,
    driver,
    secretName: tokenSecretNameOf(row),
    models: picked.length ? picked : settings.catalogModels,
  };
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
 * What the gateway says a key spent this period and of what, as a budget
 * (the views, the budget warnings): where a replaced key's spend is carried
 * as a lower limit (OpenRouter), the amounts still running are added back,
 * so the spend and the budget read the same on every gateway. An amount
 * whose period is over no longer counts, even before the check releases it.
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

/**
 * What the gateway says a key spent, in the terms `carryAfter` reads it
 * (LiteLLM's: the spend with every amount the key still carries in it).
 * Where a replaced key's spend is carried as a lower limit (OpenRouter),
 * those amounts are added to the usage the gateway reports.
 */
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
 * A secret's value, or null only when there is none. Any other failure (the
 * database, a value that won't decrypt) throws: a key must never be taken for
 * "replaced" and deleted on the gateway because a read failed once.
 */
export async function storedSecretOrNull(
  ...args: Parameters<typeof retrieveSecret>
): Promise<string | null> {
  try {
    return await retrieveSecret(...args);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Secret not found:")) return null;
    throw err;
  }
}

/** The value in the key's own secret now (null = none), the person's or the team's. */
export async function keySecretValue(row: IssuedRow): Promise<string | null> {
  if (row.kind === "person") {
    return row.userId ? storedSecretOrNull(row.secretName, "user", undefined, row.userId) : null;
  }
  return row.teamId
    ? storedSecretOrNull(row.secretName, "team", row.workspaceId, undefined, row.teamId)
    : null;
}

/** Whether the key's own secret still holds it (a person or team may have pasted another since). */
async function secretHolds(row: IssuedRow): Promise<boolean> {
  const value = await keySecretValue(row);
  return value !== null && keyValueHash(value) === row.keyHash;
}

/** Remove the key's secret when it still holds this key. */
async function removeKeySecret(row: IssuedRow): Promise<void> {
  if (!(await secretHolds(row))) return;
  if (row.kind === "person" && row.userId) {
    await deleteSecret(row.secretName, "user", null, row.userId);
  } else if (row.kind === "team" && row.teamId) {
    await deleteSecret(row.secretName, "team", row.workspaceId, null, row.teamId);
  }
}

/**
 * Take a key out of use: blocked (spend kept on the gateway) or deleted
 * there, its secret removed when it still holds this key, the row marked
 * revoked. A gateway or database failure throws and leaves the row active,
 * so the housekeeping check tries again (blocking and deleting are safe to
 * repeat). The secret is read before the gateway is touched, so a failing
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
  // A person's key (a team's, where the gateway has no teams): what it spent
  // this period, read before it goes, so the key that follows starts from
  // there (spendToCarry).
  const last =
    driver && (row.kind === "person" || !driver.teams)
      ? await carrySpendOf(driver, row).catch(() => null)
      : null;
  // A token that can't be read throws here, before the gateway is touched.
  await keySecretValue(row);
  if (driver) {
    if (how === "block") await driver.blockKey(gatewayKeyIdOf(row));
    else await driver.deleteKeys([gatewayKeyIdOf(row)]);
  } else {
    const label = await getModelProviderRow(row.providerId)
      .then((p) => (p ? gatewayLabelOf(p) : "the gateway"))
      .catch(() => "the gateway");
    logger.warn(
      { keyId: row.id, alias: row.keyAlias },
      `gateway key: no admin key stored; marked revoked in Optio only (block it in ${label})`,
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

const inFlight = new Set<string>();

/** One key-making at a time per person or team on this instance (a double click). */
async function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) throw new GatewayKeyError("Optio is already making this key", 409);
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}

// ── A person's key ───────────────────────────────────────────────────────────

async function activePersonKey(providerId: string, userId: string): Promise<IssuedRow | null> {
  const [row] = await db
    .select()
    .from(gatewayIssuedKeys)
    .where(
      and(
        eq(gatewayIssuedKeys.providerId, providerId),
        eq(gatewayIssuedKeys.kind, "person"),
        eq(gatewayIssuedKeys.userId, userId),
        eq(gatewayIssuedKeys.status, "active"),
      ),
    )
    .orderBy(desc(gatewayIssuedKeys.createdAt))
    .limit(1);
  return row ?? null;
}

/** Whose keys: a person's or a team's. */
type KeyOwner = { kind: "person"; userId: string } | { kind: "team"; teamId: string };

/** The person's (or team's) most recent key on the gateway, whatever its status. */
async function latestKey(providerId: string, owner: KeyOwner): Promise<IssuedRow | null> {
  const [row] = await db
    .select()
    .from(gatewayIssuedKeys)
    .where(
      and(
        eq(gatewayIssuedKeys.providerId, providerId),
        eq(gatewayIssuedKeys.kind, owner.kind),
        owner.kind === "person"
          ? eq(gatewayIssuedKeys.userId, owner.userId)
          : eq(gatewayIssuedKeys.teamId, owner.teamId),
      ),
    )
    .orderBy(desc(gatewayIssuedKeys.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * A new value for the key `row` names, where the gateway rotates in place
 * (Portkey); null when the gateway no longer has the key (someone deleted
 * it there), so the caller makes a new one.
 */
async function rotateInPlace(
  driver: GatewayKeyDriver,
  row: IssuedRow,
  alias: string,
): Promise<GeneratedKey | null> {
  try {
    return await driver.rotateKey!(gatewayKeyIdOf(row), row.keyAlias ?? alias);
  } catch (err) {
    if (err instanceof GatewayAdminError && err.status === 404) return null;
    throw err;
  }
}

/**
 * A key the gateway gave a new value in place (Portkey's rotate): the row
 * goes, the key stays on the gateway under the row that replaced it.
 */
async function markRotatedInPlace(row: IssuedRow): Promise<void> {
  await db
    .update(gatewayIssuedKeys)
    .set({
      status: "revoked",
      revokedReason: "rotated",
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(gatewayIssuedKeys.id, row.id));
}

/**
 * What a person's new key carries over (gateway-key-carry.ts): the amounts
 * their last key on the gateway carried that are still running, plus what
 * that key spent itself while its period runs. That key is the one being
 * rotated (its spend read live) or else the last one they gave up or lost
 * (the spend saved when it went). LiteLLM counts a budget per key, so without
 * this "Rotate", or "Give up" then "Get my token", would start the budget
 * over. Each amount carries only until its own key's period ends; the
 * housekeeping check then takes it off, so spend never piles up across
 * rotations.
 */
export async function spendToCarry(
  admin: GatewayAdmin,
  providerId: string,
  userId: string,
  now = new Date(),
): Promise<CarriedSpend[]> {
  return carryFor(admin, providerId, { kind: "person", userId }, now);
}

/**
 * `spendToCarry` for a person's or a team's keys. A team's carries only on
 * a gateway without teams (on LiteLLM the team's budget is the team's, not
 * its key's); nothing carries where the gateway rotates a key in place.
 */
async function carryFor(
  admin: GatewayAdmin,
  providerId: string,
  owner: KeyOwner,
  now = new Date(),
): Promise<CarriedSpend[]> {
  const driver = keyDriver(admin);
  if (!driver.carry || (owner.kind === "team" && driver.teams)) return [];
  const last = await latestKey(providerId, owner);
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
    {
      spend: num(last.spendUsd) ?? 0,
      resetAt: last.budgetResetAt,
      readAt,
    },
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
  viewer: Pick<KeyActor, "workspaceId" | "userId">,
): Promise<MyGatewayKeyStatus> {
  const row = await defaultGateway(viewer.workspaceId);
  const settings = row ? keyIssuingOf(row) : null;
  const modes = settings?.modes ?? gatewayKeyModesOf(null);
  const issued = row && viewer.userId ? await activePersonKey(row.id, viewer.userId) : null;
  const d = settings?.defaults ?? gatewayKeyDefaultsOf(null);
  return {
    gateway: row ? { id: row.id, name: row.name, type: modelGatewayTypeOf(row.gatewayType) } : null,
    modes,
    canIssue:
      !!row &&
      !!viewer.userId &&
      modes.optioIssued &&
      row.tokenSource === "personal" &&
      !!settings?.hasAdminKey,
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
  secretName: string;
  test: GatewayTestResult;
}

/**
 * "Get my token" / "Rotate" (`POST /api/gateway/me/key[/rotate]`): a new key
 * on the gateway for the viewer, stored as their gateway token; the key it
 * replaces is deleted there (Portkey gives the same key a new value
 * instead). `rotate` insists there is one to replace.
 */
export async function issuePersonalKey(
  viewer: Pick<KeyActor, "workspaceId" | "userId">,
  opts: { rotate?: boolean } = {},
  from?: AuditFrom,
): Promise<IssueResult> {
  const userId = viewer.userId;
  if (!userId) throw new GatewayKeyError("Sign in to get your own gateway token", 403);
  const ctx = await issuingContext(viewer.workspaceId);
  return once(`person:${ctx.row.id}:${userId}`, async () => {
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
    let inPlace = !!old && !!ctx.driver.rotateKey;
    // Read before the old key is touched: what it spent this period carries over.
    const carry =
      d.maxBudget !== null && !inPlace ? await spendToCarry(ctx.admin, ctx.row.id, userId) : [];
    const carried = carriedTotal(carry);
    // A key rotated in place keeps its budget unless the defaults name one.
    let maxBudget = inPlace && d.maxBudget === null ? num(old!.maxBudget) : d.maxBudget;
    let budgetDuration =
      maxBudget === null
        ? null
        : inPlace && d.maxBudget === null
          ? old!.budgetDuration
          : d.budgetDuration;
    let made: GeneratedKey | null = null;
    try {
      if (inPlace) {
        made = await rotateInPlace(ctx.driver, old!, personalGatewayKeyAlias(person));
        if (!made) {
          // Someone deleted the key on the gateway: a new one, as a first key.
          inPlace = false;
          maxBudget = d.maxBudget;
          budgetDuration = d.maxBudget !== null ? d.budgetDuration : null;
        } else if (d.maxBudget !== null && ctx.driver.setKeyBudget) {
          await ctx.driver.setKeyBudget(gatewayKeyIdOf(old!), { maxBudget, budgetDuration }, 0);
        }
      }
      if (!made) {
        made = await generateWithAlias(
          ctx.driver,
          {
            keyAlias: personalGatewayKeyAlias(person),
            userId: litellmUser,
            models: ctx.models,
            maxBudget: d.maxBudget,
            budgetDuration: d.maxBudget !== null ? d.budgetDuration : null,
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
      }
    } catch (err) {
      fromGateway(err);
    }
    await storeSecret(ctx.secretName, made.key, "user", null, userId);
    const [saved] = await db
      .insert(gatewayIssuedKeys)
      .values({
        workspaceId: ctx.row.workspaceId,
        providerId: ctx.row.id,
        kind: "person",
        userId,
        secretName: ctx.secretName,
        keyHash: made.keyHash,
        gatewayKeyId: made.keyId ?? null,
        keyAlias: made.keyAlias,
        keyHint: keyHint(made.key),
        litellmUserId: ctx.driver.type === "litellm" ? litellmUser : null,
        models: ctx.models,
        maxBudget: maxBudget === null ? null : String(maxBudget),
        budgetDuration,
        expiresAt: inPlace ? old!.expiresAt : (made.expiresAt ?? durationEnd(d.keyDuration)),
        spendUsd: carried > 0 ? String(carried) : null,
        carriedSpend: carry.length ? carry : null,
        createdBy: userId,
      })
      .returning();
    if (old && inPlace) {
      await markRotatedInPlace(old);
    } else if (old) {
      await retireKey(old, "delete", "rotated", ctx.admin).catch((err) =>
        logger.warn(
          { err: String(err), keyId: old.id },
          "gateway key: the replaced key is left for the housekeeping check to delete",
        ),
      );
    }
    const action = old ? "rotate" : "issue";
    audit(from, `gateway_key.${action}`, ctx.row.workspaceId, {
      id: ctx.row.id,
      scope: "user",
      keyAlias: made.keyAlias,
      maxBudget,
      budgetDuration,
    });
    return {
      action,
      key: issuedKeyView(saved),
      secretName: ctx.secretName,
      test: await gatewayTest(ctx.row, made.key),
    };
  });
}

/** `DELETE /api/gateway/me/key`: the viewer gives up the key Optio made them (deleted on the gateway). */
export async function revokePersonalKey(
  viewer: Pick<KeyActor, "workspaceId" | "userId">,
  from?: AuditFrom,
): Promise<{ revoked: number }> {
  if (!viewer.userId) throw new GatewayKeyError("Sign in first", 403);
  const row = await defaultGateway(viewer.workspaceId);
  const key = row ? await activePersonKey(row.id, viewer.userId) : null;
  if (!row || !key) throw new GatewayKeyError("You have no key Optio made", 404);
  try {
    await retireKey(key, "delete", "revoked by its owner", gatewayAdminOf(row));
  } catch (err) {
    fromGateway(err);
  }
  audit(from, "gateway_key.revoke", row.workspaceId, {
    id: row.id,
    scope: "user",
    keyAlias: key.keyAlias,
    reason: "revoked by its owner",
  });
  return { revoked: 1 };
}

/**
 * For other code (offboarding, workspace removal): block every key Optio made
 * for `userId` — in one workspace's gateways, or everywhere — on the gateway,
 * and remove the token from their secrets. Never throws; answers how many were
 * revoked and which couldn't be (the housekeeping check retries those).
 *
 *   await revokeIssuedGatewayKeys(userId, { workspaceId, reason: "left the directory" });
 */
export async function revokeIssuedGatewayKeys(
  userId: string,
  opts: { workspaceId?: string | null; reason?: string; req?: FastifyRequest | null } = {},
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
          eq(gatewayIssuedKeys.kind, "person"),
          eq(gatewayIssuedKeys.userId, userId),
          eq(gatewayIssuedKeys.status, "active"),
          ...(opts.workspaceId ? [eq(gatewayIssuedKeys.workspaceId, opts.workspaceId)] : []),
        ),
      );
    for (const row of rows) {
      try {
        await retireKey(row, "block", reason);
        revoked++;
        audit({ req: opts.req }, "gateway_key.revoke", row.workspaceId, {
          id: row.providerId,
          scope: "user",
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

// ── A team's key and budget ──────────────────────────────────────────────────

async function activeTeamKey(providerId: string, teamId: string): Promise<IssuedRow | null> {
  const [row] = await db
    .select()
    .from(gatewayIssuedKeys)
    .where(
      and(
        eq(gatewayIssuedKeys.providerId, providerId),
        eq(gatewayIssuedKeys.kind, "team"),
        eq(gatewayIssuedKeys.teamId, teamId),
        eq(gatewayIssuedKeys.status, "active"),
      ),
    )
    .orderBy(desc(gatewayIssuedKeys.createdAt))
    .limit(1);
  return row ?? null;
}

/** The LiteLLM team Optio made for `teamId` on this gateway before (a revoked key's too). */
async function knownLiteLLMTeam(providerId: string, teamId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: gatewayIssuedKeys.litellmTeamId })
    .from(gatewayIssuedKeys)
    .where(
      and(
        eq(gatewayIssuedKeys.providerId, providerId),
        eq(gatewayIssuedKeys.teamId, teamId),
        isNotNull(gatewayIssuedKeys.litellmTeamId),
      ),
    )
    .orderBy(desc(gatewayIssuedKeys.createdAt))
    .limit(1);
  return row?.id ?? null;
}

interface TeamRef {
  id: string;
  name: string;
  workspaceId: string;
  canManage: boolean;
}

/** The team, for someone who may see it (404 otherwise); `manage` also needs its admin or a workspace admin. */
async function requireTeam(teamId: string, actor: KeyActor, manage: boolean): Promise<TeamRef> {
  const [team] = /^[0-9a-f-]{36}$/i.test(teamId)
    ? await db
        .select({ id: teams.id, name: teams.name, workspaceId: teams.workspaceId })
        .from(teams)
        .where(eq(teams.id, teamId))
    : [];
  const member = (actor.teamIds ?? []).includes(teamId);
  const teamAdmin = (actor.adminTeamIds ?? []).includes(teamId);
  if (!team || team.workspaceId !== actor.workspaceId || !(actor.isAdmin || member || teamAdmin)) {
    throw new GatewayKeyError("Team not found", 404);
  }
  const canManage = actor.isAdmin || teamAdmin;
  if (manage && !canManage) {
    throw new GatewayKeyError("Only the team's admins change its gateway key and budget", 403);
  }
  return { ...team, canManage };
}

export interface TeamBudgetView {
  spend: number | null;
  maxBudget: number | null;
  budgetDuration: string | null;
  budgetResetAt: string | null;
  /** "gateway": read from the gateway now; "saved": what Optio saw at its last check. */
  source: "gateway" | "saved";
}

export interface TeamGatewayKeyStatus {
  team: { id: string; name: string };
  gateway: { id: string; name: string; type: ModelGatewayType } | null;
  modes: GatewayKeyModes;
  canIssue: boolean;
  canManage: boolean;
  hasToken: boolean;
  issued: IssuedKeyView | null;
  budget: TeamBudgetView | null;
  /** A new team key's budget and period, and the most a team admin may set (null = no cap). */
  defaults: { maxBudget: number | null; budgetDuration: string | null };
  budgetCap: number | null;
}

function savedBudget(row: IssuedRow): TeamBudgetView {
  return {
    spend: num(row.spendUsd),
    maxBudget: num(row.maxBudget),
    budgetDuration: row.budgetDuration,
    budgetResetAt: row.budgetResetAt?.toISOString() ?? null,
    source: "saved",
  };
}

function liveBudget(spend: GatewaySpend, row: IssuedRow): TeamBudgetView {
  return {
    spend: spend.spend,
    maxBudget: spend.maxBudget,
    budgetDuration: spend.budgetDuration ?? row.budgetDuration,
    budgetResetAt: spend.budgetResetAt,
    source: "gateway",
  };
}

/**
 * The team's budget as the gateway says now (LiteLLM: the team's; elsewhere
 * the team key's own), else as Optio last saw it.
 */
export async function teamBudgetOf(
  row: IssuedRow,
  admin: GatewayAdmin | null,
): Promise<TeamBudgetView> {
  const driver = admin ? keyDriver(admin) : null;
  if (driver?.teams && driver.teamSpend && row.litellmTeamId) {
    const live = await driver.teamSpend(row.litellmTeamId).catch(() => null);
    if (live) return liveBudget(live, row);
  } else if (driver && !driver.teams) {
    const live = await keySpendOf(driver, row).catch(() => null);
    if (live) return liveBudget(live, row);
  }
  return savedBudget(row);
}

/** `GET /api/gateway/teams/:teamId`: the team's token, the key Optio made it and its budget. */
export async function teamGatewayKeyStatus(
  teamId: string,
  actor: KeyActor,
): Promise<TeamGatewayKeyStatus> {
  const team = await requireTeam(teamId, actor, false);
  const row = await defaultGateway(actor.workspaceId);
  const settings = row ? keyIssuingOf(row) : null;
  const modes = settings?.modes ?? gatewayKeyModesOf(null);
  const issued = row ? await activeTeamKey(row.id, team.id) : null;
  const hasToken = row
    ? await retrieveSecret(tokenSecretNameOf(row), "team", team.workspaceId, undefined, team.id)
        .then(() => true)
        .catch(() => false)
    : false;
  const d = settings?.defaults ?? gatewayKeyDefaultsOf(null);
  return {
    team: { id: team.id, name: team.name },
    gateway: row ? { id: row.id, name: row.name, type: modelGatewayTypeOf(row.gatewayType) } : null,
    modes,
    canIssue:
      !!row && modes.optioIssued && row.tokenSource === "personal" && !!settings?.hasAdminKey,
    canManage: team.canManage,
    hasToken,
    issued: issued ? issuedKeyView(issued) : null,
    budget: issued && row ? await teamBudgetOf(issued, gatewayAdminOf(row)) : null,
    defaults: { maxBudget: d.teamMaxBudget, budgetDuration: d.teamBudgetDuration },
    budgetCap: actor.isAdmin ? null : d.teamMaxBudget,
  };
}

export interface TeamBudgetInput {
  /** USD per period; null = no cap (workspace admins only, when a cap is set). */
  maxBudget?: number | null;
  budgetDuration?: string | null;
}

/**
 * A team budget: what `input` sets, else what the team has now (`current`).
 * A team admin may not raise it above the gateway's team cap; a workspace
 * admin isn't capped. Only a raise counts: keeping a budget a workspace
 * admin set above the cap (Rotate sends none; a new period alone keeps the
 * amount) or lowering it is any team admin's to do.
 */
export function checkTeamBudget(
  input: TeamBudgetInput,
  current: { maxBudget: number | null; budgetDuration: string | null },
  defaults: Pick<GatewayKeyDefaults, "teamMaxBudget">,
  actor: Pick<KeyActor, "isAdmin">,
  type: ModelGatewayType = "litellm",
): { maxBudget: number | null; budgetDuration: string | null } {
  const maxBudget =
    input.maxBudget !== undefined
      ? typedAmount(type, input.maxBudget, "The team's budget")
      : current.maxBudget;
  const budgetDuration =
    input.budgetDuration !== undefined
      ? typedPeriod(type, input.budgetDuration, "The budget period")
      : current.budgetDuration;
  const cap = defaults.teamMaxBudget;
  const overCap = maxBudget === null || (cap !== null && maxBudget > cap);
  // null = no cap at all: from any amount, that is a raise.
  const raises =
    current.maxBudget !== null && (maxBudget === null || maxBudget > current.maxBudget);
  if (!actor.isAdmin && cap !== null && overCap && raises) {
    throw new GatewayKeyError(
      `A team admin may set a budget of up to ${cap} USD; a workspace admin can set more`,
      403,
    );
  }
  return { maxBudget, budgetDuration: maxBudget !== null ? budgetDuration : null };
}

/**
 * "Create team key" (`POST /api/gateway/teams/:teamId/key`; the team's
 * admins and workspace admins): on LiteLLM a LiteLLM team with the budget
 * (made once, reused after) and a key bound to it; on a gateway without
 * teams one key whose own limit is the team's budget. Stored as the team's
 * gateway token. With a key already there it rotates: a new key, the old one
 * deleted (Portkey: the same key, a new value).
 */
export async function createTeamKey(
  teamId: string,
  actor: KeyActor,
  input: TeamBudgetInput = {},
  from?: AuditFrom,
): Promise<IssueResult & { budget: TeamBudgetView }> {
  const team = await requireTeam(teamId, actor, true);
  const ctx = await issuingContext(actor.workspaceId);
  return once(`team:${ctx.row.id}:${team.id}`, async () => {
    const old = await activeTeamKey(ctx.row.id, team.id);
    const d = ctx.settings.defaults;
    const budget = checkTeamBudget(
      input,
      old
        ? { maxBudget: num(old.maxBudget), budgetDuration: old.budgetDuration }
        : { maxBudget: d.teamMaxBudget, budgetDuration: d.teamBudgetDuration },
      d,
      actor,
      ctx.settings.gatewayType,
    );
    const budgetGiven = input.maxBudget !== undefined || input.budgetDuration !== undefined;
    const metadata = {
      optio_team_id: team.id,
      optio_gateway_id: ctx.row.id,
      optio_workspace_id: team.workspaceId,
      made_by: "optio",
    };
    const made = ctx.driver.teams
      ? await makeLiteLLMTeamKey(ctx, team, old, budget, budgetGiven, metadata)
      : await makeTeamKeyWithLimit(ctx, team, old, budget, budgetGiven, metadata);
    await storeSecret(ctx.secretName, made.key.key, "team", team.workspaceId, null, team.id);
    const [saved] = await db
      .insert(gatewayIssuedKeys)
      .values({
        workspaceId: team.workspaceId,
        providerId: ctx.row.id,
        kind: "team",
        teamId: team.id,
        secretName: ctx.secretName,
        keyHash: made.key.keyHash,
        gatewayKeyId: made.key.keyId ?? null,
        keyAlias: made.key.keyAlias,
        keyHint: keyHint(made.key.key),
        litellmTeamId: made.litellmTeamId,
        models: ctx.models,
        maxBudget: budget.maxBudget === null ? null : String(budget.maxBudget),
        budgetDuration: budget.budgetDuration,
        expiresAt: made.inPlace
          ? old!.expiresAt
          : (made.key.expiresAt ?? durationEnd(d.keyDuration)),
        spendUsd: made.carried > 0 ? String(made.carried) : null,
        carriedSpend: made.carry.length ? made.carry : null,
        createdBy: actor.userId,
      })
      .returning();
    if (old && made.inPlace) {
      await markRotatedInPlace(old);
    } else if (old) {
      await retireKey(old, "delete", "rotated", ctx.admin).catch((err) =>
        logger.warn(
          { err: String(err), keyId: old.id },
          "gateway key: the replaced team key is left for the housekeeping check to delete",
        ),
      );
    }
    const details = {
      id: ctx.row.id,
      scope: "team",
      teamId: team.id,
      keyAlias: made.key.keyAlias,
      maxBudget: budget.maxBudget,
      budgetDuration: budget.budgetDuration,
    };
    audit(from, old ? "gateway_key.rotate" : "team_key.create", team.workspaceId, details);
    if (!old || budgetGiven) audit(from, "budget.set", team.workspaceId, details);
    return {
      action: old ? "rotate" : "issue",
      key: issuedKeyView(saved),
      secretName: ctx.secretName,
      test: await gatewayTest(ctx.row, made.key.key),
      budget: await teamBudgetOf(saved, ctx.admin),
    };
  });
}

interface MadeTeamKey {
  key: GeneratedKey;
  litellmTeamId: string | null;
  /** The gateway gave the old key a new value (Portkey): the old row goes, the key stays. */
  inPlace: boolean;
  carry: CarriedSpend[];
  carried: number;
}

/**
 * LiteLLM: the team's LiteLLM team (the one Optio made before, made again if
 * someone removed it in LiteLLM; its budget updated when one is given or the
 * team has no key yet) and a key bound to it.
 */
async function makeLiteLLMTeamKey(
  ctx: IssuingContext,
  team: TeamRef,
  old: IssuedRow | null,
  budget: { maxBudget: number | null; budgetDuration: string | null },
  budgetGiven: boolean,
  metadata: Record<string, string>,
): Promise<MadeTeamKey> {
  const driver = ctx.driver;
  const d = ctx.settings.defaults;
  const makeTeam = () =>
    driver.newTeam!({
      alias: `optio-${gatewayKeyAliasPart(team.name)}`,
      models: ctx.models,
      metadata,
      ...budget,
    });
  let made: GeneratedKey;
  let litellmTeamId: string;
  try {
    const known = old?.litellmTeamId ?? (await knownLiteLLMTeam(ctx.row.id, team.id));
    litellmTeamId = known ?? (await makeTeam());
    let remade = false;
    if (known && (budgetGiven || !old)) {
      await driver.updateTeamBudget!(known, budget).catch(async (err) => {
        // The team was removed in LiteLLM: make it again.
        if (err instanceof LiteLLMError && (err.status === 404 || isTeamMissing(err))) {
          litellmTeamId = await makeTeam();
          remade = true;
          return;
        }
        throw err;
      });
    }
    const keyInput = (): GenerateKeyInput => ({
      keyAlias: teamGatewayKeyAlias(team.name),
      teamId: litellmTeamId,
      models: ctx.models,
      duration: d.keyDuration,
      metadata,
    });
    try {
      made = await generateWithAlias(driver, keyInput(), old);
    } catch (err) {
      // Rotate doesn't touch the team first: a team someone removed in
      // LiteLLM shows here. Make it again (same budget) and try once more.
      if (remade || !isTeamMissing(err)) throw err;
      litellmTeamId = await makeTeam();
      made = await generateWithAlias(driver, keyInput(), old);
    }
  } catch (err) {
    fromGateway(err);
  }
  return { key: made, litellmTeamId, inPlace: false, carry: [], carried: 0 };
}

/**
 * A gateway without teams: one key whose own limit is the team's budget.
 * Rotating gives the same key a new value where the gateway can (Portkey),
 * else a new key that carries what the old one spent this period
 * (OpenRouter, as a lower limit).
 */
async function makeTeamKeyWithLimit(
  ctx: IssuingContext,
  team: TeamRef,
  old: IssuedRow | null,
  budget: { maxBudget: number | null; budgetDuration: string | null },
  budgetGiven: boolean,
  metadata: Record<string, string>,
): Promise<MadeTeamKey> {
  const driver = ctx.driver;
  try {
    // A key someone deleted on the gateway can't be rotated: a new one follows.
    const rotated =
      old && driver.rotateKey
        ? await rotateInPlace(driver, old, teamGatewayKeyAlias(team.name))
        : null;
    if (old && rotated) {
      if (budgetGiven && driver.setKeyBudget) {
        await driver.setKeyBudget(gatewayKeyIdOf(old), budget, 0);
      }
      return { key: rotated, litellmTeamId: null, inPlace: true, carry: [], carried: 0 };
    }
    const carry =
      budget.maxBudget !== null
        ? await carryFor(ctx.admin, ctx.row.id, { kind: "team", teamId: team.id })
        : [];
    const carried = carriedTotal(carry);
    const key = await generateWithAlias(
      driver,
      {
        keyAlias: teamGatewayKeyAlias(team.name),
        models: ctx.models,
        maxBudget: budget.maxBudget,
        budgetDuration: budget.budgetDuration,
        duration: ctx.settings.defaults.keyDuration,
        spend: carried,
        metadata,
      },
      old,
    );
    return { key, litellmTeamId: null, inPlace: false, carry, carried };
  } catch (err) {
    fromGateway(err);
  }
}

/**
 * `PUT /api/gateway/teams/:teamId/budget`: the team's budget on the gateway
 * (LiteLLM: its LiteLLM team's, `/team/update`; elsewhere its key's limit).
 */
export async function setTeamBudget(
  teamId: string,
  actor: KeyActor,
  input: TeamBudgetInput,
  from?: AuditFrom,
): Promise<TeamBudgetView> {
  const team = await requireTeam(teamId, actor, true);
  const row = await defaultGateway(actor.workspaceId);
  const key = row ? await activeTeamKey(row.id, team.id) : null;
  const litellm = modelGatewayTypeOf(row?.gatewayType) === "litellm";
  if (!row || !key || (litellm && !key.litellmTeamId)) {
    throw new GatewayKeyError("The team has no key Optio made; create one first", 404);
  }
  const admin = gatewayAdminOf(row);
  if (!admin) {
    throw new GatewayKeyError(
      `An admin hasn't stored the ${adminKeyName(row)} for ${row.name} yet (Settings → Model gateway)`,
    );
  }
  const settings = keyIssuingOf(row);
  const budget = checkTeamBudget(
    input,
    { maxBudget: num(key.maxBudget), budgetDuration: key.budgetDuration },
    settings.defaults,
    actor,
    settings.gatewayType,
  );
  const driver = keyDriver(admin);
  try {
    if (driver.teams && key.litellmTeamId) {
      await driver.updateTeamBudget!(key.litellmTeamId, budget);
    } else if (driver.setKeyBudget) {
      // What the key still carries from the one before it stays off its limit.
      const still = carriedTotal(
        carriedOf(key.carriedSpend).filter(
          (p) => p.until === null || new Date(p.until).getTime() > Date.now(),
        ),
      );
      await driver.setKeyBudget(gatewayKeyIdOf(key), budget, driver.carry === "limit" ? still : 0);
    }
  } catch (err) {
    fromGateway(err);
  }
  const [saved] = await db
    .update(gatewayIssuedKeys)
    .set({
      maxBudget: budget.maxBudget === null ? null : String(budget.maxBudget),
      budgetDuration: budget.budgetDuration,
      // A new budget is a new start for the warnings.
      warnedLevel: 0,
      warnedPeriod: null,
      updatedAt: new Date(),
    })
    .where(eq(gatewayIssuedKeys.id, key.id))
    .returning();
  audit(from, "budget.set", team.workspaceId, {
    id: row.id,
    scope: "team",
    teamId: team.id,
    maxBudget: budget.maxBudget,
    budgetDuration: budget.budgetDuration,
  });
  return teamBudgetOf(saved, admin);
}

/** `DELETE /api/gateway/teams/:teamId/key`: the team's Optio-made key, deleted on the gateway. */
export async function revokeTeamKey(
  teamId: string,
  actor: KeyActor,
  from?: AuditFrom,
): Promise<{ revoked: number }> {
  const team = await requireTeam(teamId, actor, true);
  const row = await defaultGateway(actor.workspaceId);
  const key = row ? await activeTeamKey(row.id, team.id) : null;
  if (!row || !key) throw new GatewayKeyError("The team has no key Optio made", 404);
  try {
    await retireKey(key, "delete", "revoked by a team admin", gatewayAdminOf(row));
  } catch (err) {
    fromGateway(err);
  }
  audit(from, "gateway_key.revoke", team.workspaceId, {
    id: row.id,
    scope: "team",
    teamId: team.id,
    keyAlias: key.keyAlias,
    reason: "revoked by a team admin",
  });
  return { revoked: 1 };
}

/**
 * For `DELETE /api/model-providers/:id`, before the row (and the admin key)
 * goes: every key Optio made on the gateway is deleted there, the people's
 * and teams' tokens that still hold one are removed, and each is audited as
 * `gateway_key.revoke`. Only for a workspace admin of the gateway's
 * workspace, the one who may delete it.
 *
 * When the gateway can't delete them (unreachable, the admin key refused,
 * or no admin key stored), the answer is a `refusal` for the route's 409 and
 * nothing changes: the keys would otherwise stay live on the gateway with no
 * record left in Optio once the gateway's rows go. With `force` the delete
 * goes on, and the audit entries say the keys are still on the gateway.
 */
export async function revokeProviderKeys(
  providerId: string,
  actor: Pick<KeyActor, "workspaceId" | "isAdmin">,
  opts: { force?: boolean; req?: FastifyRequest | null } = {},
): Promise<{ revoked: number; refusal: string | null }> {
  const provider = /^[0-9a-f-]{36}$/i.test(providerId)
    ? await getModelProviderRow(providerId)
    : null;
  if (!provider || provider.kind !== "gateway" || !actor.isAdmin) {
    return { revoked: 0, refusal: null };
  }
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

  const label = gatewayLabelOf(provider);
  let problem: string | null = null;
  let admin: GatewayAdmin | null = null;
  try {
    admin = gatewayAdminOf(provider);
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }
  if (admin) {
    try {
      await keyDriver(admin).deleteKeys(rows.map((r) => gatewayKeyIdOf(r)));
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  } else if (!problem) {
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
    // Best effort: the keys no longer work (or the admin chose to go on).
    await removeKeySecret(row).catch((err) =>
      logger.warn({ err: String(err), keyId: row.id }, "gateway key: couldn't remove its token"),
    );
    audit({ req: opts.req }, "gateway_key.revoke", row.workspaceId, {
      id: providerId,
      scope: row.kind === "team" ? "team" : "user",
      teamId: row.teamId ?? undefined,
      targetUserId: row.userId ?? undefined,
      keyAlias: row.keyAlias,
      reason,
    });
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
  if (problem) {
    logger.warn(
      { providerId, keys: rows.map((r) => r.keyAlias), problem },
      "gateway key: the gateway was deleted with keys still on it",
    );
  }
  return { revoked: rows.length, refusal: null };
}

/** Whether a share of a budget is spent (for the check and the views). */
export function budgetFraction(spend: number | null, maxBudget: number | null): number | null {
  if (spend === null || maxBudget === null || maxBudget <= 0) return null;
  return spend / maxBudget;
}
