import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  interactiveSessions,
  localHosts,
  persistentAgents,
  prReviews,
  tasks,
  workDefinitions,
  workflowRuns,
} from "../db/schema.js";
import { canSee, type Actor } from "./ownership.js";
import { canSeeWork } from "./work-visibility.js";

const TASK_EVENTS = new Set([
  "task:state_changed",
  "task:created",
  "task:pending_reason",
  "task:stalled",
  "task:recovered",
  "task:comment",
  "task:message_delivered",
  "task:message_acked",
]);
const AGENT_EVENTS = new Set([
  "persistent_agent:state_changed",
  "persistent_agent:turn_started",
  "persistent_agent:turn_halted",
]);
const REVIEW_EVENTS = new Set([
  "pr_review:state_changed",
  "pr_review_run:state_changed",
  "pr_review:stale",
]);

/**
 * The Redis bus is deployment-wide; a browser's events stream is not. Resolve
 * the current row before forwarding any resource frame. Optional owner fields
 * on older producers are never an authorization boundary, and unknown/deleted
 * resources fail closed. Logs use their separately authorized entity streams.
 */
export async function globalEventFor(
  input: unknown,
  actor: Actor,
): Promise<Record<string, unknown> | null> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const event = input as Record<string, unknown>;
  if (typeof event.type !== "string") return null;
  let resource:
    | {
        workspaceId: string | null;
        ownerUserId?: string | null;
        ownerTeamId?: string | null;
        createdBy?: string | null;
      }
    | undefined;
  // Tasks, Job runs and agents follow the work-visibility rule (and their
  // team); every other resource the scope rule alone.
  let work = false;

  if (TASK_EVENTS.has(event.type) && typeof event.taskId === "string") {
    work = true;
    [resource] = await db
      .select({
        workspaceId: tasks.workspaceId,
        ownerUserId: tasks.ownerUserId,
        ownerTeamId: tasks.ownerTeamId,
        createdBy: tasks.createdBy,
      })
      .from(tasks)
      .where(eq(tasks.id, event.taskId));
  } else if (
    event.type === "workflow_run:state_changed" &&
    typeof event.workflowRunId === "string"
  ) {
    work = true;
    [resource] = await db
      .select({
        workspaceId: workDefinitions.workspaceId,
        ownerUserId: workDefinitions.ownerUserId,
        ownerTeamId: workDefinitions.ownerTeamId,
        createdBy: workDefinitions.createdBy,
      })
      .from(workflowRuns)
      .innerJoin(workDefinitions, eq(workflowRuns.workflowId, workDefinitions.id))
      .where(eq(workflowRuns.id, event.workflowRunId));
  } else if (AGENT_EVENTS.has(event.type) && typeof event.agentId === "string") {
    work = true;
    [resource] = await db
      .select({
        workspaceId: persistentAgents.workspaceId,
        ownerUserId: persistentAgents.ownerUserId,
        ownerTeamId: persistentAgents.ownerTeamId,
        createdBy: persistentAgents.createdBy,
      })
      .from(persistentAgents)
      .where(eq(persistentAgents.id, event.agentId));
  } else if (REVIEW_EVENTS.has(event.type) && typeof event.prReviewId === "string") {
    [resource] = await db
      .select({ workspaceId: prReviews.workspaceId })
      .from(prReviews)
      .where(eq(prReviews.id, event.prReviewId));
  } else if (
    ["session:created", "session:ended"].includes(event.type) &&
    typeof event.sessionId === "string"
  ) {
    [resource] = await db
      .select({
        workspaceId: interactiveSessions.workspaceId,
        ownerUserId: interactiveSessions.userId,
      })
      .from(interactiveSessions)
      .where(eq(interactiveSessions.id, event.sessionId));
    // Session content/identity is private to the owner, including from admins.
    if (resource?.ownerUserId && resource.ownerUserId !== actor.userId) return null;
  } else if (event.type === "local:changed" && typeof event.hostId === "string") {
    [resource] = await db
      .select({ workspaceId: localHosts.workspaceId, ownerUserId: localHosts.userId })
      .from(localHosts)
      .where(eq(localHosts.id, event.hostId));
    if (resource?.ownerUserId && resource.ownerUserId !== actor.userId) return null;
  } else if (event.type === "activity:new") {
    const audience = event.audience;
    if (
      !audience ||
      typeof audience !== "object" ||
      !("workspaceId" in audience) ||
      !("ownerUserId" in audience)
    )
      return null;
    const { workspaceId, ownerUserId } = audience;
    if (
      (workspaceId !== null && typeof workspaceId !== "string") ||
      (ownerUserId !== null && typeof ownerUserId !== "string")
    )
      return null;
    resource = { workspaceId, ownerUserId };
  } else if (["auth:failed", "auth:status_changed"].includes(event.type)) {
    // These are deployment-wide status nudges about the global agent credential.
    // Never forward arbitrary producer text, ids, or other private metadata.
    return {
      type: event.type,
      timestamp: event.timestamp,
      ...(event.type === "auth:failed" ? { message: "Agent authentication needs attention." } : {}),
    };
  } else {
    return null;
  }

  if (
    !resource ||
    resource.workspaceId !== actor.workspaceId ||
    !(work ? canSeeWork(resource, actor) : canSee(resource.ownerUserId, actor))
  )
    return null;
  const { audience: _audience, ...visible } = event;
  return visible;
}
