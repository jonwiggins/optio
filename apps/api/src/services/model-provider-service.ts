import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  MODEL_PROVIDER_AGENTS,
  MODEL_PROVIDER_POD_CREDENTIALS,
  bedrockRuntime,
  isModelProviderAgent,
  isValidAwsProfileName,
  isValidAwsRegion,
  modelProviderIdFrom,
  type CreateModelProviderInput,
  type ModelProvider,
  type ModelProviderAgent,
  type ModelProviderCredentials,
  type ModelProviderLaunch,
  type ModelProviderModel,
  type ModelProviderPodCredential,
  type UpdateModelProviderInput,
} from "@optio/shared";
import { db } from "../db/client.js";
import { modelProviders, users } from "../db/schema.js";
import { decrypt, encrypt } from "./secret-service.js";

/**
 * Model providers (Settings → Model providers): Amazon Bedrock for Claude
 * Code and Codex, owned by the organization (`owner_user_id` null) or by one
 * person. Work picks one through `agentOptions.modelProvider`; see
 * `@optio/shared` `types/model-provider.ts` for the model.
 *
 * Who may use one: the organization's, by any work in the workspace; a
 * personal one, only by work its owner owns (and on its owner's machines).
 * Pod credentials are encrypted on the row and never leave the server for a
 * machine — a machine uses its own AWS profile.
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
    region: row.region,
    models: row.models as ModelProvider["models"],
    localAwsProfile: row.localAwsProfile,
    podCredential: row.podCredential,
    hasPodCredentials: !!row.encryptedCredentials,
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

function cleanModels(
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
      cleaned.push(label ? { id, label } : { id });
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
}

function normalizeFields(input: UpdateModelProviderInput): NormalizedFields {
  const out: NormalizedFields = {};
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

export async function createModelProvider(
  input: CreateModelProviderInput,
  viewer: ProviderViewer,
): Promise<ModelProvider> {
  if (input.kind !== "bedrock") throw new ModelProviderError(`Unknown provider "${input.kind}"`);
  // Auth-disabled dev has no user to own a personal provider: it's the org's.
  const ownerUserId = input.owner === "me" && viewer.userId ? viewer.userId : null;
  if (!ownerUserId && !viewer.isAdmin) {
    throw new ModelProviderError("Only admins can add a model provider for the organization", 403);
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
 * machines only).
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

/** What a spawn on a machine carries: where to call, which AWS profile — no credentials. */
export function providerLaunch(row: ModelProviderRow): ModelProviderLaunch {
  return {
    kind: row.kind,
    providerId: row.id,
    name: row.name,
    region: row.region,
    ...(row.localAwsProfile ? { awsProfile: row.localAwsProfile } : {}),
  };
}

/** The env + Codex overrides a pod run gets for the provider, credentials included. */
export function podProviderRuntime(
  row: ModelProviderRow,
  agentType: string,
): { env: Record<string, string>; codexConfig: string[] } {
  if (!isModelProviderAgent(agentType)) return { env: {}, codexConfig: [] };
  const credentials =
    row.podCredential === "access-key" || row.podCredential === "bearer-token"
      ? openCredentials(row)
      : null;
  return bedrockRuntime(agentType, { region: row.region }, credentials);
}
