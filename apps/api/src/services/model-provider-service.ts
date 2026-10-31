import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  MODEL_PROVIDER_AGENTS,
  MODEL_PROVIDER_AUTH_HEADERS,
  MODEL_PROVIDER_MODEL_ROLES,
  MODEL_PROVIDER_POD_CREDENTIALS,
  MODEL_PROVIDER_TOKEN_SOURCES,
  bedrockRuntime,
  gatewayModelOptionKey,
  gatewayModelPick,
  gatewayRuntime,
  gatewayTokenSecretName,
  isModelGatewayType,
  isModelProviderAgent,
  isModelProviderKind,
  isValidAwsProfileName,
  isValidAwsRegion,
  isValidGatewayUrl,
  modelGatewayTypeOf,
  modelProviderIdFrom,
  normalizeGatewayBaseUrl,
  type CreateModelProviderInput,
  type GatewayModelPick,
  type GatewayRuntimeSource,
  type ModelProvider,
  type ModelProviderAgent,
  type ModelProviderAuthHeader,
  type ModelProviderCredentials,
  type ModelProviderLaunch,
  type ModelProviderModel,
  type ModelProviderPodCredential,
  type ModelProviderTokenSource,
  type ModelGatewayType,
  type UpdateModelProviderInput,
} from "@optio/shared";
import { db } from "../db/client.js";
import { modelProviders, secrets, users } from "../db/schema.js";
import { decrypt, encrypt } from "./secret-service.js";

/**
 * Model providers (Settings → Model providers): Amazon Bedrock for Claude
 * Code and Codex, or a model gateway (LiteLLM or any OpenAI- /
 * Anthropic-compatible endpoint; docs/model-gateway.md), owned by the
 * organization (`owner_user_id` null) or by one person. Work picks
 * one through `agentOptions.modelProvider`; see `@optio/shared`
 * `types/model-provider.ts` for the model.
 *
 * Who may use one: the organization's, by any work in the workspace; a
 * personal one, only by work its owner owns (and on its owner's machines).
 * Bedrock's pod credentials are encrypted on the row and never leave the
 * server for a machine — a machine uses its own AWS profile. A gateway's
 * token is the work owner's own (`tokenSource: "personal"`, resolved at run
 * time by `model-gateway-service.ts`) or one sealed on the row (`stored`).
 */

export type ModelProviderRow = typeof modelProviders.$inferSelect;

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

/** Who is asking: their workspace, id (null when auth is disabled) and whether they're an admin. */
export interface ProviderViewer {
  workspaceId: string | null;
  userId: string | null;
  isAdmin: boolean;
}

function credentialsAAD(id: string): Buffer {
  return Buffer.from(`model_provider|${id}`);
}

function sameWorkspace(a: string | null, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

export function toModelProvider(
  row: ModelProviderRow,
  viewer: ProviderViewer,
  ownerName: string | null = null,
): ModelProvider {
  const mine = !!row.ownerUserId && row.ownerUserId === viewer.userId;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerUserId ? ownerName : null,
    kind: row.kind,
    name: row.name,
    agents: row.agents.filter(isModelProviderAgent),
    region: row.region ?? "",
    models: row.models as ModelProvider["models"],
    localAwsProfile: row.localAwsProfile,
    podCredential: row.podCredential,
    hasPodCredentials: !!row.encryptedCredentials,
    gatewayType: row.kind === "gateway" ? modelGatewayTypeOf(row.gatewayType) : null,
    baseUrl: row.baseUrl,
    authHeader: row.authHeader,
    syncUrl: row.syncUrl,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    tokenSource: row.tokenSource,
    mine,
    canEdit: row.ownerUserId ? mine : viewer.isAdmin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function ownerNames(rows: ModelProviderRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.ownerUserId).filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.displayName || u.email]));
}

/**
 * The providers a viewer sees: the organization's and their own; an admin
 * also sees other members' personal ones (by name, read-only).
 */
export async function listModelProviders(viewer: ProviderViewer): Promise<ModelProvider[]> {
  const ws = viewer.workspaceId
    ? eq(modelProviders.workspaceId, viewer.workspaceId)
    : isNull(modelProviders.workspaceId);
  const visible = viewer.isAdmin
    ? undefined
    : viewer.userId
      ? or(isNull(modelProviders.ownerUserId), eq(modelProviders.ownerUserId, viewer.userId))
      : isNull(modelProviders.ownerUserId);
  const rows = await db
    .select()
    .from(modelProviders)
    .where(visible ? and(ws, visible) : ws)
    .orderBy(modelProviders.name);
  const names = await ownerNames(rows);
  return rows.map((r) => toModelProvider(r, viewer, names.get(r.ownerUserId ?? "") ?? null));
}

export async function getModelProviderRow(id: string): Promise<ModelProviderRow | null> {
  const [row] = await db.select().from(modelProviders).where(eq(modelProviders.id, id));
  return row ?? null;
}

// ── Validation ───────────────────────────────────────────────────────────────

const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function cleanCount(value: unknown, what: string, id: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ModelProviderError(`${what} for "${id}" must be a number of tokens`);
  }
  return Math.floor(n);
}

/** A model's gateway details, cleaned (docs/model-gateway.md's catalog shape). */
function cleanGatewayFields(m: ModelProviderModel, id: string): Partial<ModelProviderModel> {
  const out: Partial<ModelProviderModel> = {};
  const contextWindow = cleanCount(m.contextWindow, "The context window", id);
  if (contextWindow) out.contextWindow = contextWindow;
  const maxOutputTokens = cleanCount(m.maxOutputTokens, "The output limit", id);
  if (maxOutputTokens) out.maxOutputTokens = maxOutputTokens;
  if (m.efforts !== undefined) {
    const efforts = [...new Set((m.efforts ?? []).map((e) => String(e).trim()).filter(Boolean))];
    for (const e of efforts) {
      if (e.length > 20 || /\s/.test(e)) {
        throw new ModelProviderError(`Effort "${e}" for "${id}" isn't valid`);
      }
    }
    out.efforts = efforts;
  }
  const defaultEffort = m.defaultEffort?.trim();
  if (defaultEffort) {
    if (out.efforts && !out.efforts.includes(defaultEffort)) {
      throw new ModelProviderError(
        `The default effort "${defaultEffort}" for "${id}" isn't one of its efforts`,
      );
    }
    out.defaultEffort = defaultEffort;
  }
  if (m.prices && typeof m.prices === "object") {
    const prices: NonNullable<ModelProviderModel["prices"]> = {};
    for (const key of PRICE_KEYS) {
      const v = m.prices[key];
      if (v === undefined || v === null) continue;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new ModelProviderError(`The ${key} price for "${id}" must be USD per million tokens`);
      }
      prices[key] = n;
    }
    if (Object.keys(prices).length > 0) out.prices = prices;
  }
  if (m.role !== undefined && m.role !== null) {
    if (!MODEL_PROVIDER_MODEL_ROLES.includes(m.role)) {
      throw new ModelProviderError(`Unknown role "${m.role}" for "${id}" (opus, sonnet, haiku)`);
    }
    out.role = m.role;
  }
  if (m.missing === true) out.missing = true;
  return out;
}

export function cleanModels(
  models: CreateModelProviderInput["models"] | undefined,
  agents: ModelProviderAgent[],
): Record<string, ModelProviderModel[]> {
  const out: Record<string, ModelProviderModel[]> = {};
  for (const agent of agents) {
    const list = models?.[agent] ?? [];
    const seen = new Set<string>();
    const cleaned: ModelProviderModel[] = [];
    for (const m of list) {
      const id = m.id?.trim();
      if (!id) continue;
      if (id.length > 200 || /\s/.test(id)) {
        throw new ModelProviderError(`Model id "${id}" isn't valid`);
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const label = m.label?.trim();
      cleaned.push({ id, ...(label ? { label } : {}), ...cleanGatewayFields(m, id) });
    }
    out[agent] = cleaned;
  }
  return out;
}

function validateCredentials(
  kind: ModelProviderPodCredential,
  credentials: ModelProviderCredentials,
): void {
  if (credentials.type !== kind) {
    throw new ModelProviderError(
      `Pod credentials are a ${credentials.type} but the provider is set to ${kind}`,
    );
  }
  if (credentials.type === "access-key") {
    if (!credentials.accessKeyId?.trim() || !credentials.secretAccessKey?.trim()) {
      throw new ModelProviderError("An AWS access key needs both the key id and the secret");
    }
  } else if (!credentials.bearerToken?.trim()) {
    throw new ModelProviderError("The Bedrock API key is empty");
  }
}

interface NormalizedFields {
  name?: string;
  agents?: ModelProviderAgent[];
  region?: string;
  localAwsProfile?: string | null;
  podCredential?: ModelProviderPodCredential;
  gatewayType?: ModelGatewayType;
  baseUrl?: string;
  authHeader?: ModelProviderAuthHeader;
  syncUrl?: string | null;
  tokenSource?: ModelProviderTokenSource;
}

/** The gateway fields of an input, validated (docs/model-gateway.md). */
function normalizeGatewayFields(input: UpdateModelProviderInput): NormalizedFields {
  const out: NormalizedFields = {};
  if (input.gatewayType !== undefined) {
    if (!isModelGatewayType(input.gatewayType)) {
      throw new ModelProviderError(
        `Unknown gateway type "${String(input.gatewayType)}" (generic, litellm)`,
      );
    }
    out.gatewayType = input.gatewayType;
  }
  if (input.baseUrl !== undefined) {
    const baseUrl = normalizeGatewayBaseUrl(input.baseUrl);
    if (!isValidGatewayUrl(baseUrl)) {
      throw new ModelProviderError(
        "The gateway URL must be http(s)://host[:port][/path], like https://litellm.example.com",
      );
    }
    out.baseUrl = baseUrl;
  }
  if (input.authHeader !== undefined) {
    if (!MODEL_PROVIDER_AUTH_HEADERS.includes(input.authHeader)) {
      throw new ModelProviderError(`Unknown auth header "${input.authHeader}" (bearer, api-key)`);
    }
    out.authHeader = input.authHeader;
  }
  if (input.syncUrl !== undefined) {
    const syncUrl = input.syncUrl ? normalizeGatewayBaseUrl(input.syncUrl) : "";
    if (syncUrl && !isValidGatewayUrl(syncUrl)) {
      throw new ModelProviderError("The sync URL must be an http(s) URL, like the gateway's");
    }
    out.syncUrl = syncUrl || null;
  }
  if (input.tokenSource !== undefined) {
    if (!MODEL_PROVIDER_TOKEN_SOURCES.includes(input.tokenSource)) {
      throw new ModelProviderError(
        `Unknown token source "${input.tokenSource}" (personal, stored)`,
      );
    }
    out.tokenSource = input.tokenSource;
  }
  return out;
}

function normalizeFields(input: UpdateModelProviderInput): NormalizedFields {
  const out: NormalizedFields = normalizeGatewayFields(input);
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new ModelProviderError("Give the provider a name");
    out.name = name;
  }
  if (input.agents !== undefined) {
    const agents = [...new Set(input.agents)].filter(isModelProviderAgent);
    if (agents.length === 0) {
      throw new ModelProviderError(
        `Pick at least one agent (${MODEL_PROVIDER_AGENTS.join(", ")}) for the provider`,
      );
    }
    out.agents = agents;
  }
  if (input.region !== undefined) {
    const region = input.region.trim();
    if (!isValidAwsRegion(region)) {
      throw new ModelProviderError(`"${region}" isn't an AWS region (like us-west-2)`);
    }
    out.region = region;
  }
  if (input.localAwsProfile !== undefined) {
    const p = input.localAwsProfile?.trim() || null;
    if (p && !isValidAwsProfileName(p)) {
      throw new ModelProviderError(`"${p}" isn't an AWS profile name`);
    }
    out.localAwsProfile = p;
  }
  if (input.podCredential !== undefined) {
    if (!MODEL_PROVIDER_POD_CREDENTIALS.includes(input.podCredential)) {
      throw new ModelProviderError(`Unknown pod credential "${input.podCredential}"`);
    }
    out.podCredential = input.podCredential;
  }
  return out;
}

function sealCredentials(id: string, credentials: ModelProviderCredentials) {
  const blob = encrypt(JSON.stringify(credentials), credentialsAAD(id));
  return {
    encryptedCredentials: blob.ciphertext,
    credentialsIv: blob.iv,
    credentialsAuthTag: blob.authTag,
  };
}

function openCredentials(row: ModelProviderRow): ModelProviderCredentials | null {
  if (!row.encryptedCredentials || !row.credentialsIv || !row.credentialsAuthTag) return null;
  const json = decrypt(
    {
      alg: 1,
      iv: row.credentialsIv,
      ciphertext: row.encryptedCredentials,
      authTag: row.credentialsAuthTag,
    },
    credentialsAAD(row.id),
    `model provider ${row.name}`,
  );
  return JSON.parse(json) as ModelProviderCredentials;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

function assertCanEdit(row: ModelProviderRow, viewer: ProviderViewer): void {
  if (!sameWorkspace(row.workspaceId, viewer.workspaceId)) {
    throw new ModelProviderError("Model provider not found", 404);
  }
  if (row.ownerUserId) {
    if (row.ownerUserId !== viewer.userId) {
      throw new ModelProviderError("Only its owner can change a personal model provider", 403);
    }
  } else if (!viewer.isAdmin) {
    throw new ModelProviderError("Only admins can change the organization's model providers", 403);
  }
}

/**
 * A gateway's pod credential follows its token source: `stored` seals one
 * bearer token on the row, `personal` stores nothing (the token is the work
 * owner's, resolved at run time).
 */
function gatewayPodCredential(tokenSource: ModelProviderTokenSource): ModelProviderPodCredential {
  return tokenSource === "stored" ? "bearer-token" : "none";
}

export async function createModelProvider(
  input: CreateModelProviderInput,
  viewer: ProviderViewer,
): Promise<ModelProvider> {
  if (!isModelProviderKind(input.kind)) {
    throw new ModelProviderError(`Unknown provider "${input.kind}"`);
  }
  // Auth-disabled dev has no user to own a personal provider: it's the org's.
  const ownerUserId = input.owner === "me" && viewer.userId ? viewer.userId : null;
  if (!ownerUserId && !viewer.isAdmin) {
    throw new ModelProviderError("Only admins can add a model provider for the organization", 403);
  }
  if (input.kind === "gateway") return createGateway(input, viewer, ownerUserId);
  if (input.region === undefined) {
    throw new ModelProviderError('"" isn\'t an AWS region (like us-west-2)');
  }
  const fields = normalizeFields({ ...input, agents: input.agents ?? [], region: input.region });
  const agents = fields.agents!;
  const podCredential = fields.podCredential ?? "none";
  if (input.credentials) validateCredentials(podCredential, input.credentials);
  if (podCredential !== "none" && podCredential !== "ambient" && !input.credentials) {
    throw new ModelProviderError(
      "Add the pod credentials, or pick another way for pods to sign in",
    );
  }
  const [row] = await db
    .insert(modelProviders)
    .values({
      workspaceId: viewer.workspaceId,
      ownerUserId,
      createdBy: viewer.userId,
      kind: "bedrock",
      name: fields.name!,
      agents,
      region: fields.region!,
      models: cleanModels(input.models, agents),
      localAwsProfile: fields.localAwsProfile ?? null,
      podCredential,
    })
    .returning();
  let saved = row;
  if (input.credentials && (podCredential === "access-key" || podCredential === "bearer-token")) {
    [saved] = await db
      .update(modelProviders)
      .set(sealCredentials(row.id, input.credentials))
      .where(eq(modelProviders.id, row.id))
      .returning();
  }
  const names = await ownerNames([saved]);
  return toModelProvider(saved, viewer, names.get(saved.ownerUserId ?? "") ?? null);
}

/** A gateway (docs/model-gateway.md): where it listens, what it serves, whose token. */
async function createGateway(
  input: CreateModelProviderInput,
  viewer: ProviderViewer,
  ownerUserId: string | null,
): Promise<ModelProvider> {
  if (!input.baseUrl?.trim()) throw new ModelProviderError("Give the gateway its URL");
  const fields = normalizeFields({
    name: input.name,
    agents: input.agents ?? [],
    gatewayType: input.gatewayType ?? modelGatewayTypeOf(null),
    baseUrl: input.baseUrl,
    authHeader: input.authHeader ?? "bearer",
    syncUrl: input.syncUrl ?? null,
    tokenSource: input.tokenSource ?? "personal",
  });
  const agents = fields.agents!;
  const tokenSource = fields.tokenSource!;
  const podCredential = gatewayPodCredential(tokenSource);
  if (tokenSource === "stored") {
    if (!input.credentials) {
      throw new ModelProviderError(
        "Add the gateway's shared token, or let each person use their own",
      );
    }
    validateCredentials("bearer-token", input.credentials);
  }
  const [row] = await db
    .insert(modelProviders)
    .values({
      workspaceId: viewer.workspaceId,
      ownerUserId,
      createdBy: viewer.userId,
      kind: "gateway",
      name: fields.name!,
      agents,
      region: null,
      models: cleanModels(input.models, agents),
      localAwsProfile: null,
      podCredential,
      gatewayType: fields.gatewayType!,
      baseUrl: fields.baseUrl!,
      authHeader: fields.authHeader!,
      syncUrl: fields.syncUrl ?? null,
      tokenSource,
    })
    .returning();
  let saved = row;
  if (tokenSource === "stored" && input.credentials) {
    [saved] = await db
      .update(modelProviders)
      .set(sealCredentials(row.id, input.credentials))
      .where(eq(modelProviders.id, row.id))
      .returning();
  }
  const names = await ownerNames([saved]);
  return toModelProvider(saved, viewer, names.get(saved.ownerUserId ?? "") ?? null);
}

/**
 * The gateway part of an update: type, URL, header, sync URL, token source
 * and its token. A token is bound to the URLs it was given for: moving a
 * `stored` gateway to another base or sync URL needs its shared token again
 * (people's own and the organization's tokens stop being read until they
 * are entered again; `hasGatewayTokenConsent`).
 */
function gatewayUpdates(
  row: ModelProviderRow,
  input: UpdateModelProviderInput,
  fields: NormalizedFields,
  updates: Partial<typeof modelProviders.$inferInsert>,
): void {
  if (fields.gatewayType !== undefined) updates.gatewayType = fields.gatewayType;
  if (fields.baseUrl !== undefined) updates.baseUrl = fields.baseUrl;
  if (fields.authHeader !== undefined) updates.authHeader = fields.authHeader;
  if (fields.syncUrl !== undefined) updates.syncUrl = fields.syncUrl;
  const tokenSource = fields.tokenSource ?? row.tokenSource;
  const movesUrl =
    (fields.baseUrl !== undefined && fields.baseUrl !== row.baseUrl) ||
    (fields.syncUrl !== undefined && (fields.syncUrl ?? null) !== (row.syncUrl ?? null));
  if (movesUrl && tokenSource === "stored" && !input.credentials) {
    throw new ModelProviderError(
      "The gateway's URL changed: add its shared token again, so it is only sent where it was given for",
    );
  }
  if (fields.tokenSource !== undefined) {
    updates.tokenSource = tokenSource;
    updates.podCredential = gatewayPodCredential(tokenSource);
  }
  if (input.credentials === null || tokenSource === "personal") {
    updates.encryptedCredentials = null;
    updates.credentialsIv = null;
    updates.credentialsAuthTag = null;
  } else if (input.credentials) {
    validateCredentials("bearer-token", input.credentials);
    Object.assign(updates, sealCredentials(row.id, input.credentials));
  } else if (tokenSource !== row.tokenSource) {
    throw new ModelProviderError("Add the gateway's shared token to store one");
  }
}

export async function updateModelProvider(
  id: string,
  input: UpdateModelProviderInput,
  viewer: ProviderViewer,
): Promise<ModelProvider> {
  const row = await getModelProviderRow(id);
  if (!row) throw new ModelProviderError("Model provider not found", 404);
  assertCanEdit(row, viewer);
  const fields = normalizeFields(input);
  const updates: Partial<typeof modelProviders.$inferInsert> = { updatedAt: new Date() };
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.region !== undefined) updates.region = fields.region;
  if (fields.localAwsProfile !== undefined) updates.localAwsProfile = fields.localAwsProfile;
  const agents = fields.agents ?? (row.agents.filter(isModelProviderAgent) as ModelProviderAgent[]);
  if (fields.agents !== undefined) updates.agents = agents;
  if (input.models !== undefined || fields.agents !== undefined) {
    updates.models = cleanModels(
      input.models ?? (row.models as CreateModelProviderInput["models"]),
      agents,
    );
  }
  if (input.owner !== undefined) {
    // Moving it to the org needs an admin; making it personal makes it the editor's.
    if (input.owner === "workspace" && row.ownerUserId) {
      if (!viewer.isAdmin) {
        throw new ModelProviderError(
          "Only admins can give a model provider to the organization",
          403,
        );
      }
      updates.ownerUserId = null;
    } else if (input.owner === "me" && !row.ownerUserId && viewer.userId) {
      updates.ownerUserId = viewer.userId;
    }
  }
  if (row.kind === "gateway") {
    gatewayUpdates(row, input, fields, updates);
  } else {
    const podCredential = fields.podCredential ?? row.podCredential;
    if (fields.podCredential !== undefined) updates.podCredential = podCredential;
    if (input.credentials === null || podCredential === "none" || podCredential === "ambient") {
      updates.encryptedCredentials = null;
      updates.credentialsIv = null;
      updates.credentialsAuthTag = null;
    } else if (input.credentials) {
      validateCredentials(podCredential, input.credentials);
      Object.assign(updates, sealCredentials(row.id, input.credentials));
    } else if (fields.podCredential !== undefined && fields.podCredential !== row.podCredential) {
      throw new ModelProviderError("Add the pod credentials for the new sign-in method");
    }
  }
  const [saved] = await db
    .update(modelProviders)
    .set(updates)
    .where(eq(modelProviders.id, id))
    .returning();
  const names = await ownerNames([saved]);
  return toModelProvider(saved, viewer, names.get(saved.ownerUserId ?? "") ?? null);
}

export async function deleteModelProvider(id: string, viewer: ProviderViewer): Promise<void> {
  const row = await getModelProviderRow(id);
  if (!row) throw new ModelProviderError("Model provider not found", 404);
  // Admins may remove anyone's (e.g. a departed member's); owners their own.
  if (!(viewer.isAdmin && sameWorkspace(row.workspaceId, viewer.workspaceId))) {
    assertCanEdit(row, viewer);
  }
  await db.delete(modelProviders).where(eq(modelProviders.id, id));
  // A gateway's tokens (`gateway:<id>`, every person's and the
  // organization's) go with it.
  if (row.kind === "gateway") {
    await db.delete(secrets).where(eq(secrets.name, gatewayTokenSecretName(row.id)));
  }
}

// ── Use by work ──────────────────────────────────────────────────────────────

export interface ProviderUse {
  agentType: string;
  agentOptions: Record<string, unknown> | null | undefined;
  workspaceId: string | null | undefined;
  /** The work's owner (null = the organization). */
  ownerUserId: string | null | undefined;
  runsOn: "pod" | "local";
}

/**
 * The provider a piece of work picks, checked against who may use it:
 * null when it picks none. Throws a `ModelProviderError` saying why not
 * (gone, another workspace's, someone else's, doesn't serve the agent,
 * machines only, a model the gateway doesn't serve).
 *
 * A gateway runs in pods whatever its token source: a stored token is on
 * the row, a personal one is resolved at run time (`resolveGatewayToken`).
 */
export async function resolveProviderForWork(use: ProviderUse): Promise<ModelProviderRow | null> {
  const id = modelProviderIdFrom(use.agentOptions);
  if (!id) return null;
  const row = /^[0-9a-f-]{36}$/i.test(id) ? await getModelProviderRow(id) : null;
  if (!row || !sameWorkspace(row.workspaceId, use.workspaceId)) {
    throw new ModelProviderError("The model provider this work uses was removed — pick another");
  }
  if (row.ownerUserId && row.ownerUserId !== (use.ownerUserId ?? null)) {
    throw new ModelProviderError(
      `"${row.name}" is someone's own model provider — only work they own can use it`,
    );
  }
  if (!isModelProviderAgent(use.agentType) || !row.agents.includes(use.agentType)) {
    throw new ModelProviderError(`"${row.name}" isn't set up for ${use.agentType}`);
  }
  if (row.kind === "gateway") {
    if (row.tokenSource === "stored" && !row.encryptedCredentials) {
      throw new ModelProviderError(`"${row.name}" has no shared token stored`);
    }
    const models = gatewayOf(row).models[use.agentType] ?? [];
    const wanted = use.agentOptions?.[gatewayModelOptionKey(use.agentType)];
    if (
      typeof wanted === "string" &&
      wanted.trim() &&
      !models.some((m) => m.id === wanted.trim())
    ) {
      throw new ModelProviderError(`"${row.name}" doesn't serve the model "${wanted.trim()}"`);
    }
    if (models.length === 0) {
      throw new ModelProviderError(`"${row.name}" has no models for ${use.agentType} yet`);
    }
    return row;
  }
  if (use.runsOn === "pod" && row.podCredential === "none") {
    throw new ModelProviderError(`"${row.name}" is set up for machines only, not pods`);
  }
  if (
    use.runsOn === "pod" &&
    (row.podCredential === "access-key" || row.podCredential === "bearer-token") &&
    !row.encryptedCredentials
  ) {
    throw new ModelProviderError(`"${row.name}" has no pod credentials stored`);
  }
  return row;
}

/** A provider pick that is valid for the work, as a 400-able error message (or null). */
export async function providerSelectionError(use: ProviderUse): Promise<string | null> {
  try {
    await resolveProviderForWork(use);
    return null;
  } catch (err) {
    if (err instanceof ModelProviderError) return err.message;
    throw err;
  }
}

/** The gateway a row describes, for `gatewayRuntime` / `gatewayModelPick`. */
export function gatewayOf(row: ModelProviderRow): GatewayRuntimeSource {
  return {
    type: modelGatewayTypeOf(row.gatewayType),
    baseUrl: row.baseUrl ?? "",
    authHeader: row.authHeader,
    models: row.models as GatewayRuntimeSource["models"],
  };
}

/** The bearer token sealed on a `stored` gateway, or null. */
export function storedGatewayToken(row: ModelProviderRow): string | null {
  if (row.kind !== "gateway" || row.tokenSource !== "stored") return null;
  const credentials = openCredentials(row);
  return credentials?.type === "bearer-token" ? credentials.bearerToken : null;
}

/** A gateway run: the work's pick (`gatewayModelPick`) and its token, resolved by the caller. */
export interface GatewayRun {
  agent: ModelProviderAgent;
  pick: GatewayModelPick;
  /** Null = leave the token out (the machine completes it). */
  token: string | null;
}

/**
 * What a spawn on a machine carries. Bedrock: where to call, which AWS
 * profile — no credentials. A gateway: its URL, header and, with `run`, the
 * full env including the owner's own token (docs/model-gateway.md).
 */
export function providerLaunch(row: ModelProviderRow, run?: GatewayRun): ModelProviderLaunch {
  if (row.kind === "gateway") {
    const gateway = gatewayOf(row);
    return {
      kind: "gateway",
      providerId: row.id,
      name: row.name,
      region: "",
      baseUrl: gateway.baseUrl,
      authHeader: gateway.authHeader,
      ...(run ? { env: gatewayRuntime(run.agent, gateway, run.pick, run.token).env } : {}),
    };
  }
  return {
    kind: row.kind,
    providerId: row.id,
    name: row.name,
    region: row.region ?? "",
    ...(row.localAwsProfile ? { awsProfile: row.localAwsProfile } : {}),
  };
}

/**
 * The env + Codex overrides a pod run gets for the provider, credentials
 * included. A gateway run needs its pick (`gatewayModelPick`; the first
 * model when absent) and the token the caller resolved
 * (`resolveGatewayToken`); a stored token is read from the row when none is
 * given.
 */
export function podProviderRuntime(
  row: ModelProviderRow,
  agentType: string,
  pick?: GatewayModelPick | null,
  token?: string | null,
): { env: Record<string, string>; codexConfig: string[] } {
  if (!isModelProviderAgent(agentType)) return { env: {}, codexConfig: [] };
  if (row.kind === "gateway") {
    const gateway = gatewayOf(row);
    const chosen = pick ?? gatewayModelPick(gateway, agentType, null);
    if (!chosen) return { env: {}, codexConfig: [] };
    return gatewayRuntime(agentType, gateway, chosen, token ?? storedGatewayToken(row));
  }
  const credentials =
    row.podCredential === "access-key" || row.podCredential === "bearer-token"
      ? openCredentials(row)
      : null;
  return bedrockRuntime(agentType, { region: row.region ?? "" }, credentials);
}
