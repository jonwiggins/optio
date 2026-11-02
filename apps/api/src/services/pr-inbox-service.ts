import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  comparePrInboxItems,
  derivePrStatus,
  normalizeRepoUrl,
  parseRepoUrl,
  type PrAgentAction,
  type PrAgentLink,
  type PrFacts,
  type PrInboxItem,
  type PrInboxResponse,
  type PrOptioReview,
  type PrViewerSource,
} from "@optio/shared";
import { db } from "../db/client.js";
import { prReviews, repos, taskPrs, tasks, users } from "../db/schema.js";
import { logger } from "../logger.js";
import { getGitPlatformForRepo } from "./git-token-service.js";
import { fetchGitHubPrFacts } from "./git-platform/github-pr-facts.js";
import { fetchGitLabPrFacts } from "./git-platform/gitlab-pr-facts.js";
import {
  PrQuickActionError,
  rerunFailedChecks,
  updatePrBranch,
} from "./git-platform/pr-quick-actions.js";
import * as taskService from "./task-service.js";
import { attachTaskPr } from "./task-pr-service.js";
import { controlTask } from "./task-control-service.js";
import { planNewWork, workChangeError, type WorkActor } from "./work-ownership.js";

/**
 * The pull-request panel (`/reviews`): every open PR in the workspace's
 * repositories, each with one next action for the person looking
 * (`derivePrStatus` in @optio/shared), joined with the Optio task working on
 * it and Optio's own review.
 *
 * Like `/api/pull-requests`, a request with no workspace (auth disabled)
 * sees every repository.
 *
 * Facts are cached per repository for `FRESH_MS` (per API instance, like
 * every cache here); a webhook for the repo drops its entry
 * (`invalidatePrInboxRepo`), and a manual refresh re-reads anything older
 * than `REFRESH_FLOOR_MS`.
 */

const FRESH_MS = 60_000;
const REFRESH_FLOOR_MS = 10_000;
const REPO_CONCURRENCY = 4;
const MAX_PRS_PER_REPO = 100;

interface CacheEntry {
  at: number;
  facts: PrFacts[];
}
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<PrFacts[]>>();

const cacheKey = (workspaceId: string | null, repoUrl: string) =>
  `${workspaceId ?? "-"}:${normalizeRepoUrl(repoUrl)}`;

/** A webhook said the repo's PRs changed: the next read goes to the platform. */
export function invalidatePrInboxRepo(repoUrl: string): void {
  const suffix = `:${normalizeRepoUrl(repoUrl)}`;
  for (const key of cache.keys()) if (key.endsWith(suffix)) cache.delete(key);
}

/** For tests. */
export function clearPrInboxCache(): void {
  cache.clear();
  inFlight.clear();
}

async function readRepoFacts(
  repo: { repoUrl: string; gitPlatform?: string | null },
  workspaceId: string | null,
): Promise<PrFacts[]> {
  const { platform, ri, token } = await getGitPlatformForRepo(repo.repoUrl, {
    server: true,
    workspaceId,
  });
  if (ri.platform === "github") return fetchGitHubPrFacts(ri, token, { max: MAX_PRS_PER_REPO });
  if (ri.platform === "gitlab") return fetchGitLabPrFacts(ri, token, { max: 40 });
  // CodeCommit: no checks, reviews or threads to read — the plain list.
  const prs = await platform.listOpenPullRequests(ri, { perPage: 50 });
  return prs.map((pr): PrFacts => ({
    url: pr.url,
    number: pr.number,
    title: pr.title,
    platform: ri.platform,
    repoFullName: `${ri.owner}/${ri.repo}`,
    author: pr.author,
    draft: pr.draft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    headBranch: pr.headBranch ?? null,
    baseBranch: pr.baseBranch || null,
    headSha: pr.headSha || null,
    isFork: false,
    lastPushAt: null,
    checks: "none",
    failingChecks: [],
    mergeState: pr.mergeable === false ? "conflict" : pr.mergeable ? "clean" : "unknown",
    reviewDecision: "none",
    reviews: [],
    requestedReviewers: [],
    requestedTeams: [],
    assignees: pr.assignees,
    threads: [],
    comments: [],
    bodyMentions: [],
  }));
}

async function repoFacts(
  repo: { repoUrl: string; gitPlatform?: string | null },
  workspaceId: string | null,
  refresh: boolean,
): Promise<PrFacts[]> {
  const key = cacheKey(workspaceId, repo.repoUrl);
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < (refresh ? REFRESH_FLOOR_MS : FRESH_MS)) return hit.facts;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = readRepoFacts(repo, workspaceId)
    .then((facts) => {
      cache.set(key, { at: Date.now(), facts });
      return facts;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// ── The viewer ─────────────────────────────────────────────────────────────

export interface ViewerHandles {
  handles: string[];
  source: PrViewerSource;
}

/** Who "you" are on the git platforms: linked handles, else the sign-in's own. */
export async function viewerHandles(userId: string | null): Promise<ViewerHandles> {
  if (!userId) return { handles: [], source: "none" };
  const [u] = await db
    .select({ provider: users.provider, username: users.username, gitHandles: users.gitHandles })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) return { handles: [], source: "none" };
  const linked = [u.gitHandles?.github, u.gitHandles?.gitlab].filter(
    (h): h is string => typeof h === "string" && h.length > 0,
  );
  if (linked.length > 0) return { handles: [...new Set(linked)], source: "linked" };
  if (u.username && (u.provider === "github" || u.provider === "gitlab")) {
    return { handles: [u.username], source: "sign-in" };
  }
  return { handles: [], source: "none" };
}

const HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_])?$/;

export class PrInboxError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function setViewerHandles(
  userId: string,
  input: { github?: string | null; gitlab?: string | null },
): Promise<ViewerHandles> {
  const [u] = await db
    .select({ gitHandles: users.gitHandles })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) throw new PrInboxError("No such user", 404);
  const next = { ...(u.gitHandles ?? {}) };
  for (const key of ["github", "gitlab"] as const) {
    if (!(key in input)) continue;
    const raw = input[key]?.trim().replace(/^@/, "") ?? "";
    if (!raw) delete next[key];
    else if (!HANDLE_RE.test(raw)) throw new PrInboxError(`"${raw}" isn't a valid handle`);
    else next[key] = raw;
  }
  await db
    .update(users)
    .set({ gitHandles: Object.keys(next).length > 0 ? next : null, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return viewerHandles(userId);
}

/**
 * The account behind the deployment's GitHub token — a good guess for "you"
 * on a one-person install. Null for an App installation token (it has no
 * user) or when the call fails. Cached per workspace.
 */
const suggestionCache = new Map<string, { at: number; handle: string | null }>();
async function suggestedHandle(
  workspaceId: string | null,
  repoList: Array<{ repoUrl: string }>,
): Promise<string | null> {
  const key = workspaceId ?? "-";
  const hit = suggestionCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.handle;
  let handle: string | null = null;
  const gh = repoList.find((r) => parseRepoUrl(r.repoUrl)?.platform === "github");
  if (gh) {
    try {
      const { ri, token } = await getGitPlatformForRepo(gh.repoUrl, { server: true, workspaceId });
      const res = await fetch(`${ri.apiBaseUrl}/user`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "Optio" },
      });
      if (res.ok) {
        const body = (await res.json()) as { login?: string; type?: string };
        if (body.login && body.type !== "Bot") handle = body.login;
      }
    } catch {
      // No guess.
    }
  }
  suggestionCache.set(key, { at: Date.now(), handle });
  return handle;
}

// ── The panel ──────────────────────────────────────────────────────────────

const ACTIVE_TASK_STATES = new Set([
  "pending",
  "waiting_on_deps",
  "queued",
  "provisioning",
  "running",
  "pr_opened",
  "needs_attention",
  "failed",
]);

/** The newest visible Optio task per PR URL. */
async function agentLinks(
  urls: string[],
  workspaceId: string | null,
  userId: string | null,
): Promise<Map<string, PrAgentLink>> {
  const out = new Map<string, PrAgentLink>();
  if (urls.length === 0) return out;
  const fromPrs = await db
    .select({ url: taskPrs.url, taskId: taskPrs.taskId })
    .from(taskPrs)
    .where(inArray(taskPrs.url, urls));
  const ids = [...new Set(fromPrs.map((r) => r.taskId))];
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      state: tasks.state,
      prUrl: tasks.prUrl,
      createdBy: tasks.createdBy,
      ownerUserId: tasks.ownerUserId,
      workspaceId: tasks.workspaceId,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        ids.length > 0
          ? or(inArray(tasks.prUrl, urls), inArray(tasks.id, ids))
          : inArray(tasks.prUrl, urls),
        workspaceId ? eq(tasks.workspaceId, workspaceId) : undefined,
      ),
    )
    .orderBy(desc(tasks.createdAt));
  const urlsByTask = new Map<string, Set<string>>();
  for (const r of fromPrs) {
    if (!urlsByTask.has(r.taskId)) urlsByTask.set(r.taskId, new Set());
    urlsByTask.get(r.taskId)!.add(r.url);
  }
  for (const t of rows) {
    // Someone else's private task stays theirs.
    if (t.ownerUserId && t.ownerUserId !== userId) continue;
    if (!ACTIVE_TASK_STATES.has(t.state)) continue;
    const forUrls = new Set(urlsByTask.get(t.id) ?? []);
    if (t.prUrl) forUrls.add(t.prUrl);
    for (const url of forUrls) {
      if (!urls.includes(url) || out.has(url)) continue;
      out.set(url, {
        taskId: t.id,
        title: t.title,
        state: t.state,
        startedByViewer: !!userId && t.createdBy === userId,
      });
    }
  }
  return out;
}

async function optioReviews(
  urls: string[],
  workspaceId: string | null,
): Promise<Map<string, PrOptioReview>> {
  const out = new Map<string, PrOptioReview>();
  if (urls.length === 0) return out;
  const rows = await db
    .select({
      id: prReviews.id,
      prUrl: prReviews.prUrl,
      state: prReviews.state,
      verdict: prReviews.verdict,
    })
    .from(prReviews)
    .where(
      and(
        inArray(prReviews.prUrl, urls),
        workspaceId ? eq(prReviews.workspaceId, workspaceId) : undefined,
      ),
    )
    .orderBy(desc(prReviews.updatedAt));
  for (const r of rows) {
    if (!out.has(r.prUrl)) out.set(r.prUrl, { id: r.id, state: r.state, verdict: r.verdict });
  }
  return out;
}

export async function getPrInbox(input: {
  workspaceId: string | null;
  userId: string | null;
  refresh?: boolean;
  repoId?: string;
}): Promise<PrInboxResponse> {
  const { workspaceId, userId } = input;
  const repoRows = await db
    .select({
      id: repos.id,
      fullName: repos.fullName,
      repoUrl: repos.repoUrl,
      gitPlatform: repos.gitPlatform,
    })
    .from(repos)
    .where(
      and(
        workspaceId ? eq(repos.workspaceId, workspaceId) : undefined,
        input.repoId ? eq(repos.id, input.repoId) : undefined,
      ),
    );

  const errors: PrInboxResponse["errors"] = [];
  const perRepo: Array<{ repo: (typeof repoRows)[number]; facts: PrFacts[] }> = [];
  let next = 0;
  const work = async () => {
    while (next < repoRows.length) {
      const repo = repoRows[next++];
      try {
        perRepo.push({ repo, facts: await repoFacts(repo, workspaceId, !!input.refresh) });
      } catch (err) {
        logger.warn({ err, repo: repo.fullName }, "pr-inbox: couldn't read the repo's PRs");
        errors.push({ repo: repo.fullName, message: describeError(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REPO_CONCURRENCY, repoRows.length) }, work));

  const viewer = await viewerHandles(userId);
  const urls = perRepo.flatMap((r) => r.facts.map((f) => f.url));
  const [agents, reviews] = await Promise.all([
    agentLinks(urls, workspaceId, userId),
    optioReviews(urls, workspaceId),
  ]);

  const now = Date.now();
  const items: PrInboxItem[] = perRepo.flatMap(({ repo, facts }) =>
    facts.map((f) => {
      const agent = agents.get(f.url) ?? null;
      const optioReview = reviews.get(f.url) ?? null;
      return {
        facts: f,
        status: derivePrStatus(f, viewer, { agent, optioReview, now }),
        repo: { id: repo.id, fullName: repo.fullName, repoUrl: repo.repoUrl },
        agent,
        optioReview,
      };
    }),
  );
  items.sort(comparePrInboxItems);

  return {
    viewer: {
      handles: viewer.handles,
      source: viewer.source,
      suggestedHandle:
        viewer.handles.length === 0 ? await suggestedHandle(workspaceId, repoRows) : null,
    },
    items,
    errors: errors.sort((a, b) => a.repo.localeCompare(b.repo)),
    fetchedAt: new Date(now).toISOString(),
  };
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|bad credentials/i.test(msg)) return "Optio's token for this repository was rejected";
  if (/403|not accessible|rate limit/i.test(msg))
    return msg.includes("rate")
      ? "Rate limited — try again in a minute"
      : "Optio's token can't read this repository's pull requests";
  if (/404|could not resolve/i.test(msg)) return "Repository not found with Optio's token";
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}

// ── Send to agent ──────────────────────────────────────────────────────────

/** What the agent is asked to do, for a PR it already owns or a fresh one. */
export function prAgentInstructions(facts: PrFacts, action: PrAgentAction): string {
  const base = facts.baseBranch ?? "the base branch";
  const cli = facts.platform === "gitlab" ? "glab" : "gh";
  switch (action) {
    case "fix_ci":
      return [
        `CI is failing on this pull request${facts.failingChecks.length ? ` (${facts.failingChecks.join(", ")})` : ""}.`,
        `Find out why from the check logs (\`${cli}\` if it's available), fix the cause, and push.`,
        "Don't skip, disable or loosen checks to make them pass.",
      ].join(" ");
    case "address_changes":
      return [
        "Reviewers requested changes on this pull request.",
        `Read every review and unresolved review thread (\`${cli}\` if it's available), address each point, and push.`,
        "Then reply on each thread with what you changed (or why you didn't).",
      ].join(" ");
    case "resolve_conflicts":
      return [
        `This pull request conflicts with \`${base}\`.`,
        `Merge \`origin/${base}\` into the branch, resolve the conflicts keeping the intent of both sides,`,
        "make sure it still builds and its tests pass, and push.",
      ].join(" ");
    case "update_branch":
      return [
        `This pull request is behind \`${base}\` and branch rules require it to be up to date.`,
        `Merge \`origin/${base}\` into the branch, check it still builds, and push.`,
      ].join(" ");
    case "reply":
      return [
        "There are unanswered review comments on this pull request.",
        "Read them; where a change is needed, make it and push; reply to each one.",
      ].join(" ");
  }
}

/** For a PR no Optio task owns: work on its branch, never open another PR. */
export function prAgentPrompt(facts: PrFacts, action: PrAgentAction): string {
  const head = facts.headBranch!;
  return [
    `You're working on an existing pull request: ${facts.url} (#${facts.number} "${facts.title}") in ${facts.repoFullName}.`,
    `Its branch is \`${head}\`${facts.baseBranch ? `, based on \`${facts.baseBranch}\`` : ""}.`,
    "",
    `Start by checking that branch out: \`git fetch origin ${head} && git checkout -B ${head} origin/${head}\`.`,
    `Commit on it and push to it (\`git push origin HEAD:${head}\`, with \`--force-with-lease\` only if you rewrote history).`,
    "Do not create another branch or open a new pull request.",
    "",
    prAgentInstructions(facts, action),
  ].join("\n");
}

const ACTION_TITLE: Record<PrAgentAction, string> = {
  fix_ci: "Fix CI",
  address_changes: "Address review",
  resolve_conflicts: "Resolve conflicts",
  update_branch: "Update branch",
  reply: "Answer review comments",
};

export function prAgentTitle(facts: PrFacts, action: PrAgentAction): string {
  return `${ACTION_TITLE[action]} on #${facts.number}: ${facts.title}`.slice(0, 200);
}

/** Look one PR up in the panel's (fresh) facts, scoped to the workspace's repos. */
export async function findPrFacts(
  prUrl: string,
  workspaceId: string | null,
): Promise<{
  facts: PrFacts;
  repo: { id: string; repoUrl: string; defaultBranch: string | null };
} | null> {
  const repoRows = await db
    .select({
      id: repos.id,
      repoUrl: repos.repoUrl,
      gitPlatform: repos.gitPlatform,
      defaultBranch: repos.defaultBranch,
    })
    .from(repos)
    .where(workspaceId ? eq(repos.workspaceId, workspaceId) : undefined);
  const target = prUrl.replace(/\/+$/, "").toLowerCase();
  for (const repo of repoRows) {
    const prefix = normalizeRepoUrl(repo.repoUrl)
      .replace(/\.git$/, "")
      .toLowerCase();
    if (!target.startsWith(`${prefix}/`)) continue;
    const facts = await repoFacts(repo, workspaceId, true);
    const hit = facts.find((f) => f.url.replace(/\/+$/, "").toLowerCase() === target);
    if (hit) return { facts: hit, repo };
  }
  return null;
}

export type SendToAgentResult = { taskId: string; mode: "resumed" | "restarted" | "created" };

/**
 * "Send to agent": the Optio task that owns the PR picks it up again (resume
 * when it's waiting on a person, a fresh session on its branch when it's
 * idle with its PR open); a PR no task owns gets a new Repo Task that works
 * on the PR's own branch and tracks the PR from the start.
 */
export async function sendPrToAgent(input: {
  prUrl: string;
  action: PrAgentAction;
  actor: WorkActor;
  agentType?: string;
}): Promise<SendToAgentResult> {
  const { actor } = input;
  const found = await findPrFacts(input.prUrl, actor.workspaceId);
  if (!found)
    throw new PrInboxError(
      "That pull request isn't open in one of this workspace's repositories",
      404,
    );
  const { facts, repo } = found;

  const owned = (await agentLinks([facts.url], actor.workspaceId, actor.userId)).get(facts.url);
  if (owned) {
    const task = await taskService.getTask(owned.taskId);
    if (!task) throw new PrInboxError("Task not found", 404);
    const changeErr = await workChangeError(task.ownerUserId, actor, "run");
    if (changeErr) throw new PrInboxError(changeErr, 403);
    const prompt = prAgentInstructions(facts, input.action);
    if (["needs_attention", "failed"].includes(task.state)) {
      await controlTask(task.id, "resume", { prompt, userId: actor.userId ?? undefined, task });
      return { taskId: task.id, mode: "resumed" };
    }
    if (task.state === "pr_opened") {
      await controlTask(task.id, "restart", { prompt, userId: actor.userId ?? undefined, task });
      return { taskId: task.id, mode: "restarted" };
    }
    throw new PrInboxError("An agent is already working on this pull request", 409);
  }

  if (facts.isFork) {
    throw new PrInboxError("This pull request comes from a fork: Optio can't push to its branch");
  }
  if (!facts.headBranch) throw new PrInboxError("The platform didn't report the PR's branch");

  const agentType = await taskService.resolveTaskAgent({
    agentType: input.agentType,
    repoUrl: repo.repoUrl,
    workspaceId: actor.workspaceId,
    runTarget: "cluster",
  });
  const plan = await planNewWork({}, actor, { agentType, agentOptions: null, runsOn: "pod" });
  if (!plan.ok) throw new PrInboxError(plan.error, plan.status);
  const task = await taskService.submitTask(
    {
      ownerUserId: plan.ownerUserId,
      podSecrets: plan.podSecrets ?? null,
      title: prAgentTitle(facts, input.action),
      prompt: prAgentPrompt(facts, input.action),
      repoUrl: repo.repoUrl,
      repoBranch: facts.headBranch,
      agentType,
      metadata: { source: "pr-inbox", prUrl: facts.url, prAction: input.action },
      workspaceId: actor.workspaceId,
    },
    actor.userId ?? undefined,
    // Track the PR before the task can run, so its lifecycle follows that PR.
    async (created) => {
      await attachTaskPr(created, facts.url);
    },
  );
  invalidatePrInboxRepo(repo.repoUrl);
  return { taskId: task.id, mode: "created" };
}

export type PrQuickAction = "update_branch" | "rerun_checks" | "approve";
export const PR_QUICK_ACTIONS: readonly PrQuickAction[] = [
  "update_branch",
  "rerun_checks",
  "approve",
];

/**
 * The panel's one-click platform actions, as the person (their own token
 * where they have one, like merging): update the branch, re-run failed
 * checks, approve.
 */
export async function runPrQuickAction(input: {
  prUrl: string;
  action: PrQuickAction;
  actor: WorkActor;
}): Promise<{ message: string }> {
  const { actor } = input;
  const found = await findPrFacts(input.prUrl, actor.workspaceId);
  if (!found) {
    throw new PrInboxError(
      "That pull request isn't open in one of this workspace's repositories",
      404,
    );
  }
  const { facts, repo } = found;
  const { platform, ri, token } = await getGitPlatformForRepo(repo.repoUrl, {
    ...(actor.userId ? { userId: actor.userId } : { server: true }),
    workspaceId: actor.workspaceId,
  });
  try {
    switch (input.action) {
      case "update_branch":
        await updatePrBranch(ri, token, facts.number, facts.headSha);
        return { message: `Updating #${facts.number} with ${facts.baseBranch ?? "its base"}` };
      case "rerun_checks": {
        if (!facts.headSha)
          throw new PrInboxError("The platform didn't report the PR's head commit");
        const n = await rerunFailedChecks(ri, token, facts.number, facts.headSha);
        return {
          message: `Re-running ${n === 1 ? "the failed run" : `${n} failed runs`} on #${facts.number}`,
        };
      }
      case "approve":
        await platform.submitReview(ri, facts.number, {
          event: "APPROVE",
          body: "",
          ...(facts.headSha ? { commitId: facts.headSha } : {}),
        });
        return { message: `Approved #${facts.number}` };
    }
  } catch (err) {
    if (err instanceof PrQuickActionError) throw new PrInboxError(err.message, err.status);
    if (err instanceof PrInboxError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new PrInboxError(msg.length > 300 ? `${msg.slice(0, 300)}…` : msg, 502);
  } finally {
    invalidatePrInboxRepo(repo.repoUrl);
  }
}
