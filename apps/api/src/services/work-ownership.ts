import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { teamIdOf, type WorkOwner } from "@optio/shared";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { isAuthDisabled } from "./oauth/index.js";
import { OwnerError, actorOf, knowsTeams, ownerColumnsForNew, type Actor } from "./ownership.js";
import { getModelProviderRow, providerSelectionError } from "./model-provider-service.js";
import { credentialSelectionError } from "./agent-credential-service.js";
import { listPickableSecrets, podSecretsSelectionError } from "./secret-service.js";
import { modelProviderIdFrom } from "@optio/shared";

/**
 * Who a piece of work belongs to — Tasks, scheduled Tasks, Jobs, Persistent
 * Agents. `owner_user_id` null = the organization's; set = one person's own;
 * with `owner_team_id` set too, a team's (its creator stays in
 * `owner_user_id` — see services/ownership.ts).
 *
 * Personal work runs with its owner's secrets, model providers and
 * connections, so only its owner may change it, run it by hand or change its
 * triggers (an admin may still delete it). A team's work runs with the
 * team's secrets and is its members' to see, run and change. Organization
 * work can only use organization resources. Work on a machine always belongs
 * to the machine's owner.
 */

export type WorkActor = Actor;

// Who sees whose work under the workspace's visibility mode (organization
// or teams) — the rule itself lives in work-visibility.ts.
export { canSeeWork, visibleWork, type WorkVisibility } from "./work-visibility.js";

/** The request's Actor: upstream's shape while teams are off (ownership.ts `actorOf`). */
export function workActor(req: FastifyRequest): WorkActor {
  return actorOf(req);
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
  ownerTeamId?: string | null,
): Promise<void> {
  if (!ownerUserId || isAuthDisabled()) return;
  // Teams off: a team's work is its creator's, as the lists show it.
  if (ownerTeamId && knowsTeams(actor)) {
    // A team's work: its members run and change it; workspace admins delete it.
    if ((actor.teamIds ?? []).includes(ownerTeamId)) return;
    if (action === "delete" && actor.isAdmin) return;
    throw new WorkOwnershipError(
      `Only the team's members can ${action === "run" ? "run" : action === "delete" ? "delete" : "change"} this — it runs with the team's credentials`,
    );
  }
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
  owner: WorkOwner | undefined,
  actor: WorkActor,
  resources: WorkResources,
): Promise<string | null> {
  return (await ownerColumnsForNewWork(owner, actor, resources)).ownerUserId;
}

/** `ownerForNewWork` with the team: `team:<id>` makes it the team's (the actor a member). */
export async function ownerColumnsForNewWork(
  owner: WorkOwner | undefined,
  actor: WorkActor,
  resources: WorkResources,
): Promise<{ ownerUserId: string | null; ownerTeamId: string | null }> {
  if (!actor.userId) return { ownerUserId: null, ownerTeamId: null };
  if (teamIdOf(owner)) {
    if (resources.runsOn === "local") {
      throw new WorkOwnershipError("Work on a machine is the machine's owner's, not a team's");
    }
    return ownerColumnsForNew(owner, actor);
  }
  if (resources.runsOn === "local") return { ownerUserId: actor.userId, ownerTeamId: null };
  if (owner === "me") return { ownerUserId: actor.userId, ownerTeamId: null };
  if (owner === "workspace") return { ownerUserId: null, ownerTeamId: null };
  return {
    ownerUserId: (await usesPersonalResources(actor, resources)) ? actor.userId : null,
    ownerTeamId: null,
  };
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
  requested: WorkOwner | undefined,
  actor: WorkActor,
  runsOn: "pod" | "local",
): string | null {
  return ownerColumnsAfterUpdate(current, requested, actor, runsOn).ownerUserId;
}

/** `ownerAfterUpdate` with the team: handing work to a team takes a member of it. */
export function ownerColumnsAfterUpdate(
  current: { ownerUserId: string | null; ownerTeamId?: string | null; createdBy?: string | null },
  requested: WorkOwner | undefined,
  actor: WorkActor,
  runsOn: "pod" | "local",
): { ownerUserId: string | null; ownerTeamId: string | null } {
  const keep = { ownerUserId: current.ownerUserId, ownerTeamId: current.ownerTeamId ?? null };
  if (!actor.userId) return keep;
  if (runsOn === "local") return { ownerUserId: actor.userId, ownerTeamId: null };
  if (requested === undefined) return keep;
  if (requested === "workspace") return { ownerUserId: null, ownerTeamId: null };
  const teamId = teamIdOf(requested);
  if (teamId) {
    if (!knowsTeams(actor)) throw new WorkOwnershipError("Teams are turned off");
    if (!(actor.teamIds ?? []).includes(teamId)) {
      throw new WorkOwnershipError("You're not a member of that team");
    }
    return { ownerUserId: actor.userId, ownerTeamId: teamId };
  }
  if (current.ownerUserId === actor.userId && !current.ownerTeamId) {
    return { ownerUserId: actor.userId, ownerTeamId: null };
  }
  if (actor.isAdmin || current.createdBy === actor.userId || current.ownerUserId === actor.userId) {
    return { ownerUserId: actor.userId, ownerTeamId: null };
  }
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
  ownerTeamId: string | null = null,
): Promise<string | null> {
  // The team only for a team's work (every other check keeps upstream's shape).
  const team = ownerTeamId ? { ownerTeamId } : {};
  const providerErr = await providerSelectionError({
    agentType: resources.agentType,
    agentOptions: resources.agentOptions,
    workspaceId,
    ownerUserId,
    ...team,
    runsOn: resources.runsOn,
  });
  if (providerErr) return providerErr;
  const credentialErr = await credentialSelectionError({
    agentType: resources.agentType,
    agentOptions: resources.agentOptions,
    workspaceId,
    ownerUserId,
    ...team,
    runsOn: resources.runsOn,
  });
  if (credentialErr) return credentialErr;
  if (resources.runsOn === "pod") {
    return podSecretsSelectionError(resources.podSecrets, {
      workspaceId,
      ownerUserId,
      ...team,
    });
  }
  return null;
}

/** Normalize a `podSecrets` body field: trimmed, deduped; null stays null. */
export function cleanPodSecrets(names: string[] | null | undefined): string[] | null | undefined {
  if (names === undefined || names === null) return names;
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

export type WorkPlan =
  | {
      ok: true;
      ownerUserId: string | null;
      /** Set only for a team's work (every other plan keeps upstream's shape). */
      ownerTeamId?: string | null;
      podSecrets: string[] | null | undefined;
    }
  | { ok: false; status: 400 | 403; error: string };

/** Owner + pod secrets for new work, with its provider / secrets checked (400). */
export async function planNewWork(
  input: { owner?: WorkOwner; podSecrets?: string[] | null },
  actor: WorkActor,
  work: {
    agentType: string;
    agentOptions: Record<string, unknown> | null | undefined;
    runsOn: "pod" | "local";
  },
): Promise<WorkPlan> {
  const podSecrets = cleanPodSecrets(input.podSecrets);
  const resources = { ...work, podSecrets };
  try {
    const { ownerUserId, ownerTeamId } = await ownerColumnsForNewWork(
      input.owner,
      actor,
      resources,
    );
    const error = await workResourcesError(resources, ownerUserId, actor.workspaceId, ownerTeamId);
    if (error) return { ok: false, status: 400, error };
    return { ok: true, ownerUserId, ...(ownerTeamId ? { ownerTeamId } : {}), podSecrets };
  } catch (err) {
    if (err instanceof WorkOwnershipError || err instanceof OwnerError) {
      return { ok: false, status: 403, error: err.message };
    }
    throw err;
  }
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
    ownerTeamId?: string | null;
    createdBy?: string | null;
    agentOptions: Record<string, unknown> | null | undefined;
    podSecrets: string[] | null | undefined;
  },
  input: {
    owner?: WorkOwner;
    podSecrets?: string[] | null;
    agentOptions?: Record<string, unknown> | null;
  },
  actor: WorkActor,
  work: { agentType: string; runsOn: "pod" | "local"; touchesRuntime: boolean },
): Promise<WorkPlan> {
  try {
    await assertCanChangeWork(existing.ownerUserId, actor, "edit", existing.ownerTeamId);
    const podSecrets = cleanPodSecrets(input.podSecrets);
    const { ownerUserId, ownerTeamId } = ownerColumnsAfterUpdate(
      existing,
      input.owner,
      actor,
      work.runsOn,
    );
    const touches =
      work.touchesRuntime ||
      input.owner !== undefined ||
      podSecrets !== undefined ||
      input.agentOptions !== undefined ||
      ownerUserId !== existing.ownerUserId ||
      ownerTeamId !== (existing.ownerTeamId ?? null);
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
        ownerTeamId,
      );
      if (error) return { ok: false, status: 400, error };
    }
    return {
      ok: true,
      ownerUserId,
      // A move out of a team writes null; otherwise only a team's work names one.
      ...(ownerTeamId || existing.ownerTeamId ? { ownerTeamId } : {}),
      podSecrets,
    };
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
  ownerTeamId?: string | null,
): Promise<string | null> {
  try {
    await assertCanChangeWork(ownerUserId, actor, action, ownerTeamId);
    return null;
  } catch (err) {
    if (err instanceof WorkOwnershipError) return err.message;
    throw err;
  }
}
