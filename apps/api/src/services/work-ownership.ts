import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { ResourceOwner } from "@optio/shared";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { isAuthDisabled } from "./oauth/index.js";
import { getModelProviderRow, providerSelectionError } from "./model-provider-service.js";
import { listPickableSecrets, podSecretsSelectionError } from "./secret-service.js";
import { modelProviderIdFrom } from "@optio/shared";

/**
 * Who a piece of work belongs to — Tasks, scheduled Tasks, Jobs, Persistent
 * Agents. `owner_user_id` null = the organization's; set = one person's own.
 *
 * Personal work runs with its owner's secrets, model providers and
 * connections, so only its owner may change it, run it by hand or change its
 * triggers (an admin may still delete it). Everyone in the workspace still
 * sees it. Organization work can only use organization resources. Work on a
 * machine always belongs to the machine's owner.
 */

export interface WorkActor {
  userId: string | null;
  workspaceId: string | null;
  isAdmin: boolean;
}

export function workActor(req: FastifyRequest): WorkActor {
  return {
    userId: req.user?.id ?? null,
    workspaceId: req.user?.workspaceId ?? null,
    isAdmin: isAuthDisabled() || req.user?.workspaceRole === "admin",
  };
}

/** Someone other than the owner tried to change personal work (always a 403). */
export class WorkOwnershipError extends Error {
  readonly status = 403 as const;
  constructor(message: string) {
    super(message);
    this.name = "WorkOwnershipError";
  }
}

async function displayName(userId: string): Promise<string> {
  const [u] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return u?.displayName || u?.email || "its owner";
}

/**
 * Throws unless `actor` may change work owned by `ownerUserId`.
 * `delete` is also open to admins (e.g. work left behind by someone gone).
 */
export async function assertCanChangeWork(
  ownerUserId: string | null | undefined,
  actor: WorkActor,
  action: "edit" | "run" | "delete" = "edit",
): Promise<void> {
  if (!ownerUserId || isAuthDisabled()) return;
  if (ownerUserId === actor.userId) return;
  if (action === "delete" && actor.isAdmin) return;
  const name = await displayName(ownerUserId);
  const verb = action === "run" ? "run" : action === "delete" ? "delete" : "change";
  throw new WorkOwnershipError(
    `Only ${name} can ${verb} this — it runs with their own credentials`,
  );
}

export interface WorkResources {
  agentType: string;
  agentOptions: Record<string, unknown> | null | undefined;
  podSecrets: string[] | null | undefined;
  runsOn: "pod" | "local";
}

/**
 * The owner new work gets. Explicit `owner` wins; otherwise work on a
 * machine, or work that picks a personal provider or secret, is the
 * creator's; anything else is the organization's. Without a signed-in user
 * (auth disabled) everything is the organization's.
 */
export async function ownerForNewWork(
  owner: ResourceOwner | undefined,
  actor: WorkActor,
  resources: WorkResources,
): Promise<string | null> {
  if (!actor.userId) return null;
  if (resources.runsOn === "local") return actor.userId;
  if (owner === "me") return actor.userId;
  if (owner === "workspace") return null;
  return (await usesPersonalResources(actor, resources)) ? actor.userId : null;
}

async function usesPersonalResources(actor: WorkActor, r: WorkResources): Promise<boolean> {
  const providerId = modelProviderIdFrom(r.agentOptions);
  if (providerId && /^[0-9a-f-]{36}$/i.test(providerId)) {
    const row = await getModelProviderRow(providerId);
    if (row?.ownerUserId && row.ownerUserId === actor.userId) return true;
  }
  if (r.podSecrets?.length) {
    const pickable = await listPickableSecrets(actor.workspaceId, actor.userId);
    const org = new Set(pickable.filter((s) => s.owner === "workspace").map((s) => s.name));
    if (r.podSecrets.some((n) => !org.has(n))) return true;
  }
  return false;
}

/**
 * The owner after an update. Making work personal makes it the editor's
 * (an admin, or the person who created it); handing it back to the
 * organization is its owner's call. Work moved onto a machine becomes the
 * editor's.
 */
export function ownerAfterUpdate(
  current: { ownerUserId: string | null; createdBy?: string | null },
  requested: ResourceOwner | undefined,
  actor: WorkActor,
  runsOn: "pod" | "local",
): string | null {
  if (!actor.userId) return current.ownerUserId;
  if (runsOn === "local") return actor.userId;
  if (requested === undefined) return current.ownerUserId;
  if (requested === "workspace") return null;
  if (current.ownerUserId === actor.userId) return actor.userId;
  if (actor.isAdmin || current.createdBy === actor.userId) return actor.userId;
  throw new WorkOwnershipError(
    "Only an admin or the person who created it can make this work theirs",
  );
}

/**
 * Why the work's provider / pod secrets aren't usable by its owner (400), or
 * null when they are.
 */
export async function workResourcesError(
  resources: WorkResources,
  ownerUserId: string | null,
  workspaceId: string | null,
): Promise<string | null> {
  const providerErr = await providerSelectionError({
    agentType: resources.agentType,
    agentOptions: resources.agentOptions,
    workspaceId,
    ownerUserId,
    runsOn: resources.runsOn,
  });
  if (providerErr) return providerErr;
  if (resources.runsOn === "pod") {
    return podSecretsSelectionError(resources.podSecrets, { workspaceId, ownerUserId });
  }
  return null;
}

/** Normalize a `podSecrets` body field: trimmed, deduped; null stays null. */
export function cleanPodSecrets(names: string[] | null | undefined): string[] | null | undefined {
  if (names === undefined || names === null) return names;
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

export type WorkPlan =
  | { ok: true; ownerUserId: string | null; podSecrets: string[] | null | undefined }
  | { ok: false; status: 400 | 403; error: string };

/** Owner + pod secrets for new work, with its provider / secrets checked (400). */
export async function planNewWork(
  input: { owner?: ResourceOwner; podSecrets?: string[] | null },
  actor: WorkActor,
  work: {
    agentType: string;
    agentOptions: Record<string, unknown> | null | undefined;
    runsOn: "pod" | "local";
  },
): Promise<WorkPlan> {
  const podSecrets = cleanPodSecrets(input.podSecrets);
  const resources = { ...work, podSecrets };
  const ownerUserId = await ownerForNewWork(input.owner, actor, resources);
  const error = await workResourcesError(resources, ownerUserId, actor.workspaceId);
  if (error) return { ok: false, status: 400, error };
  return { ok: true, ownerUserId, podSecrets };
}

/**
 * Owner + pod secrets after an update: 403 unless the actor may change the
 * work; 400 when the (merged) provider / secrets aren't usable by the owner.
 * A patch that touches none of owner, agent, options, secrets or location
 * (e.g. enable / disable) is not re-checked, so a removed provider doesn't
 * block pausing the work.
 */
export async function planWorkUpdate(
  existing: {
    ownerUserId: string | null;
    createdBy?: string | null;
    agentOptions: Record<string, unknown> | null | undefined;
    podSecrets: string[] | null | undefined;
  },
  input: {
    owner?: ResourceOwner;
    podSecrets?: string[] | null;
    agentOptions?: Record<string, unknown> | null;
  },
  actor: WorkActor,
  work: { agentType: string; runsOn: "pod" | "local"; touchesRuntime: boolean },
): Promise<WorkPlan> {
  try {
    await assertCanChangeWork(existing.ownerUserId, actor, "edit");
    const podSecrets = cleanPodSecrets(input.podSecrets);
    const ownerUserId = ownerAfterUpdate(existing, input.owner, actor, work.runsOn);
    const touches =
      work.touchesRuntime ||
      input.owner !== undefined ||
      podSecrets !== undefined ||
      input.agentOptions !== undefined ||
      ownerUserId !== existing.ownerUserId;
    if (touches) {
      const error = await workResourcesError(
        {
          agentType: work.agentType,
          agentOptions:
            input.agentOptions !== undefined ? input.agentOptions : existing.agentOptions,
          podSecrets: podSecrets !== undefined ? podSecrets : existing.podSecrets,
          runsOn: work.runsOn,
        },
        ownerUserId,
        actor.workspaceId,
      );
      if (error) return { ok: false, status: 400, error };
    }
    return { ok: true, ownerUserId, podSecrets };
  } catch (err) {
    if (err instanceof WorkOwnershipError) return { ok: false, status: 403, error: err.message };
    throw err;
  }
}

/** `assertCanChangeWork` as a result: the 403 message, or null when allowed. */
export async function workChangeError(
  ownerUserId: string | null | undefined,
  actor: WorkActor,
  action: "edit" | "run" | "delete",
): Promise<string | null> {
  try {
    await assertCanChangeWork(ownerUserId, actor, action);
    return null;
  } catch (err) {
    if (err instanceof WorkOwnershipError) return err.message;
    throw err;
  }
}
