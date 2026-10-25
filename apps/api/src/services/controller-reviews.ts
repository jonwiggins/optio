import { and, eq } from "drizzle-orm";
import {
  normalizeRepoUrl,
  parsePrUrl,
  type PrReviewVerdict,
  type PrReviewFileComment,
} from "@optio/shared";
import type { ControllerPrincipal } from "./controller-auth.js";
import { ControllerError, requireChange, requireManage, tenant } from "./controller-access.js";
import { getControllerWork } from "./controller-service.js";
import { db } from "../db/client.js";
import { repos, prReviewChatMessages } from "../db/schema.js";
import * as reviews from "./pr-review-service.js";
import { agentMergeBlocker } from "./auto-merge-guard.js";
import { auditEvent } from "./audit.js";

async function reviewTarget(p: ControllerPrincipal, id: string, write = false) {
  const work = await getControllerWork(p, id);
  if (work.kind !== "review") throw new ControllerError(400, "Use a review id");
  if (write) requireChange(p, work.data);
  return work.data;
}
export async function createControllerReview(p: ControllerPrincipal, prUrl: string) {
  requireManage(p);
  const parsed = parsePrUrl(prUrl);
  if (!parsed) throw new ControllerError(400, "Invalid PR URL");
  const repoUrl = normalizeRepoUrl(`https://${parsed.host}/${parsed.owner}/${parsed.repo}`);
  const [repo] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.repoUrl, repoUrl), tenant(repos.workspaceId, p.actor.workspaceId)));
  if (!repo) throw new ControllerError(404, "Repository not found in this workspace");
  try {
    const result = await reviews.launchPrReview({
      prUrl,
      workspaceId: p.actor.workspaceId ?? undefined,
      createdBy: p.actor.userId ?? undefined,
      expectedWorkspaceId: p.actor.workspaceId,
    });
    return {
      id: result.review.id,
      state: result.review.state,
      href: `/reviews/${result.review.id}`,
    };
  } catch (err) {
    if (err instanceof reviews.ReviewScopeError) throw new ControllerError(409, err.message);
    throw err;
  }
}
export async function updateControllerReview(
  p: ControllerPrincipal,
  id: string,
  updates: {
    summary?: string | null;
    verdict?: PrReviewVerdict | null;
    fileComments?: PrReviewFileComment[] | null;
  },
) {
  const row = await reviewTarget(p, id, true);
  if (!["ready", "stale"].includes(row.state))
    throw new ControllerError(409, `Cannot edit review in ${row.state} state`);
  await reviews.updatePrReviewDraft(id, updates);
  return { id, updated: true, href: `/reviews/${id}` };
}
export async function controlControllerReview(
  p: ControllerPrincipal,
  id: string,
  action: "cancel" | "rereview" | "submit",
) {
  const row = await reviewTarget(p, id, true);
  if (action === "submit") {
    if (!["ready", "stale"].includes(row.state))
      throw new ControllerError(409, `Cannot submit review in ${row.state} state`);
    const result = await reviews.submitReview(id, p.actor.userId ?? undefined);
    return { id, state: result.review.state, reviewUrl: result.reviewUrl };
  }
  await reviews.setControlIntent(id, action);
  return { id, action, accepted: true };
}
export async function controllerReviewChat(
  p: ControllerPrincipal,
  id: string,
  limit: number,
  offset: number,
) {
  await reviewTarget(p, id);
  const rows = await db
    .select()
    .from(prReviewChatMessages)
    .where(eq(prReviewChatMessages.prReviewId, id))
    .orderBy(prReviewChatMessages.createdAt, prReviewChatMessages.id)
    .limit(limit + 1)
    .offset(offset);
  return {
    messages: rows.slice(0, limit).map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content.slice(0, 8000),
      truncated: r.content.length > 8000,
      createdAt: r.createdAt,
    })),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}
export async function sendControllerReviewMessage(
  p: ControllerPrincipal,
  id: string,
  message: string,
) {
  const row = await reviewTarget(p, id, true);
  if (["reviewing", "waiting_ci", "queued"].includes(row.state))
    throw new ControllerError(409, "Wait for the review to finish before sending a message");
  await reviews.postReviewChat({ prReviewId: id, message, userId: p.actor.userId ?? undefined });
  return { id, accepted: true, href: `/reviews/${id}` };
}
export async function controllerPrStatus(p: ControllerPrincipal, id: string) {
  const row = await reviewTarget(p, id);
  return reviews.getPrStatus(row.prUrl, { workspaceId: row.workspaceId ?? null });
}

export async function mergeControllerPr(
  p: ControllerPrincipal,
  id: string,
  mergeMethod: "merge" | "squash" | "rebase",
) {
  const work = await getControllerWork(p, id);
  requireChange(p, work.data);
  const prUrl = work.kind === "review" || work.kind === "run" ? work.data.prUrl : null;
  if (!prUrl) throw new ControllerError(400, "This work has no pull request");
  // A person merges; an agent run's own token doesn't (auto-merge-guard.ts).
  const agentMerge = agentMergeBlocker(p);
  // Merges through the MCP tool, and refused agent merges, go to the
  // audit trail (docs/audit.md).
  const audit = { via: "mcp", prUrl, mergeMethod, id, runId: p.run?.id, agentId: p.run?.agentId };
  const record = (action: string, success: boolean, reason?: string) =>
    void auditEvent({
      action,
      userId: p.actor.userId,
      workspaceId: p.actor.workspaceId,
      clientIp: null,
      success,
      details: { ...audit, reason },
    });
  if (agentMerge) {
    record("pr.merge.refused", false, "agent_run");
    throw new ControllerError(403, agentMerge);
  }
  try {
    const merged = await reviews.mergePr({
      prUrl,
      mergeMethod,
      userId: p.actor.userId ?? undefined,
      workspaceId: p.actor.workspaceId ?? null,
    });
    record("pr.merge", true);
    return merged;
  } catch (err) {
    record("pr.merge", false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
