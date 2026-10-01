/**
 * The PRs a Repo Task opened or tracks (`task_prs`).
 *
 * Detection (see docs/tasks.md, "How Optio finds a task's PRs"):
 *   1. PR-creating tool calls (`gh pr create`, MCP `create_pull_request`, …)
 *      with the PR taken from that call's own result — found by the shared
 *      detector in `@optio/shared` (pr-tool-calls.ts), confirmed here.
 *   2. PRs whose head branch is the task's branch or one under it
 *      (`optio/task-<id>`, `optio/task-<id>-<slug>`, `optio/task-<id>/<slug>`).
 *   3. URLs the agent merely mentions are never adopted.
 *
 * `tasks.pr_url` stays the primary PR — the first one adopted — so the PR
 * lifecycle (reconciler, watcher, review, auto-merge) is unchanged. Every PR,
 * the primary included, has a `task_prs` row.
 */
import { and, asc, eq } from "drizzle-orm";
import {
  TASK_BRANCH_PREFIX,
  TaskState,
  branchBelongsToTask,
  parsePrUrl,
  parseRepoUrl,
  type GitPlatform,
  type PrToolCallMatch,
  type PullRequest,
  type RepoIdentifier,
  type TaskPr,
  type TaskPrSource,
} from "@optio/shared";
import { db } from "../db/client.js";
import { taskPrs, tasks } from "../db/schema.js";
import { getGitPlatformForRepo } from "./git-token-service.js";
import { logger } from "../logger.js";

/** Clock skew allowed between Optio and the git platform when checking "created during this run". */
export const PR_CREATED_SKEW_MS = 2 * 60 * 1000;

type TaskPrRow = typeof taskPrs.$inferSelect;

/** A PR ready to record. */
export interface ConfirmedPr {
  url: string;
  number: number;
  headBranch: string | null;
  headRepo: string | null;
  baseBranch: string | null;
  state: "open" | "merged" | "closed";
  source: TaskPrSource;
}

interface TaskRef {
  id: string;
  repoUrl: string;
}

function sameRepo(a: RepoIdentifier, b: RepoIdentifier): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/** The PR number in a PR / MR / CodeCommit URL. */
export function prNumberFromUrl(url: string): number | null {
  return parsePrUrl(url)?.prNumber ?? null;
}

function prState(pr: PullRequest): ConfirmedPr["state"] {
  return pr.merged ? "merged" : pr.state === "open" ? "open" : "closed";
}

function fromPlatform(pr: PullRequest, source: TaskPrSource): ConfirmedPr {
  return {
    url: pr.url,
    number: pr.number,
    headBranch: pr.headBranch ?? null,
    headRepo: pr.headRepo ?? null,
    baseBranch: pr.baseBranch || null,
    state: prState(pr),
    source,
  };
}

function codecommitConsoleUrl(ri: RepoIdentifier, id: number): string {
  return `https://${ri.owner}.console.aws.amazon.com/codesuite/codecommit/repositories/${ri.repo}/pull-requests/${id}`;
}

function isNotFound(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (status === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|not found|PullRequestDoesNotExist/i.test(msg);
}

async function platformFor(repoUrl: string): Promise<GitPlatform | null> {
  try {
    return (await getGitPlatformForRepo(repoUrl, { server: true })).platform;
  } catch (err) {
    logger.debug({ err, repoUrl }, "task-prs: no git platform for repo");
    return null;
  }
}

/**
 * Confirm the PRs a run's tool calls created against the git platform.
 *
 * A candidate is adopted when it is in the task's repo (the base repo — a
 * fork's head may live elsewhere), open or merged, and either its head branch
 * belongs to the task or it was created during this run (`runStartedAt`,
 * minus a little clock skew). When the platform can't be asked (no token, API
 * error), a candidate in the task's repo is adopted on the tool call's word.
 */
export async function confirmToolCallPrs(
  task: TaskRef,
  matches: PrToolCallMatch[],
  opts: { runStartedAt?: Date | null; platform?: GitPlatform | null; branchPrefix?: string } = {},
): Promise<ConfirmedPr[]> {
  const ri = parseRepoUrl(task.repoUrl);
  if (!ri || matches.length === 0) return [];
  const prefix = opts.branchPrefix ?? TASK_BRANCH_PREFIX;
  const platform = opts.platform === undefined ? await platformFor(task.repoUrl) : opts.platform;
  const since = opts.runStartedAt ? opts.runStartedAt.getTime() - PR_CREATED_SKEW_MS : null;
  const out: ConfirmedPr[] = [];

  for (const m of matches) {
    let number: number;
    let url: string;
    if (m.url) {
      const parsed = parsePrUrl(m.url);
      if (!parsed || !sameRepo(parsed, ri)) {
        logger.info({ taskId: task.id, prUrl: m.url }, "task-prs: created PR is in another repo");
        continue;
      }
      number = parsed.prNumber;
      url = m.url;
    } else if (m.codecommit) {
      if (ri.platform !== "codecommit" || m.codecommit.repositoryName !== ri.repo) continue;
      number = m.codecommit.pullRequestId;
      url = codecommitConsoleUrl(ri, number);
    } else {
      continue;
    }

    if (!platform) {
      logger.warn(
        { taskId: task.id, prUrl: url },
        "task-prs: git platform unavailable — adopting the PR from its create call unconfirmed",
      );
      out.push({
        url,
        number,
        headBranch: null,
        headRepo: null,
        baseBranch: null,
        state: "open",
        source: "tool_call",
      });
      continue;
    }

    let pr: PullRequest;
    try {
      pr = await platform.getPullRequest(ri, number);
    } catch (err) {
      if (isNotFound(err)) {
        logger.warn({ taskId: task.id, prUrl: url }, "task-prs: platform has no such PR — skipped");
        continue;
      }
      logger.warn(
        { err, taskId: task.id, prUrl: url },
        "task-prs: PR lookup failed — adopting the PR from its create call unconfirmed",
      );
      out.push({
        url,
        number,
        headBranch: null,
        headRepo: null,
        baseBranch: null,
        state: "open",
        source: "tool_call",
      });
      continue;
    }

    const state = prState(pr);
    if (state === "closed") {
      logger.info({ taskId: task.id, prUrl: url }, "task-prs: created PR is closed — skipped");
      continue;
    }
    const ownBranch = branchBelongsToTask(task.id, pr.headBranch, prefix);
    const created = Date.parse(pr.createdAt);
    const fresh = since == null || !Number.isFinite(created) || created >= since;
    if (!ownBranch && !fresh) {
      logger.info(
        { taskId: task.id, prUrl: url, headBranch: pr.headBranch, createdAt: pr.createdAt },
        "task-prs: PR predates the run and isn't on the task's branch — skipped",
      );
      continue;
    }
    out.push(fromPlatform({ ...pr, url: pr.url || url }, "tool_call"));
  }
  return out;
}

/**
 * Open PRs whose head branch belongs to the task: one lookup per known
 * branch (from the pod's refs) plus a prefix lookup for anything else.
 * `checked` is false when the platform couldn't be asked.
 */
export async function findBranchPrs(
  task: TaskRef,
  opts: { branches?: string[]; platform?: GitPlatform | null; branchPrefix?: string } = {},
): Promise<{ prs: ConfirmedPr[]; checked: boolean }> {
  const ri = parseRepoUrl(task.repoUrl);
  if (!ri) return { prs: [], checked: false };
  const prefix = opts.branchPrefix ?? TASK_BRANCH_PREFIX;
  const platform = opts.platform === undefined ? await platformFor(task.repoUrl) : opts.platform;
  if (!platform) return { prs: [], checked: false };

  const found = new Map<string, ConfirmedPr>();
  let checked = false;
  const add = (prs: PullRequest[]) => {
    for (const pr of prs) {
      // listOpenPullRequests(branch) is exact; the prefix lookup is a prefix
      // match, so `optio/task-<id>` must not catch `optio/task-<id>x`.
      if (pr.headBranch && !branchBelongsToTask(task.id, pr.headBranch, prefix)) continue;
      if (!found.has(pr.url)) found.set(pr.url, fromPlatform(pr, "branch"));
    }
  };

  for (const branch of (opts.branches ?? []).filter((b) =>
    branchBelongsToTask(task.id, b, prefix),
  )) {
    try {
      const prs = await platform.listOpenPullRequests(ri, { branch });
      add(prs.map((p) => ({ ...p, headBranch: p.headBranch ?? branch })));
      checked = true;
    } catch (err) {
      logger.debug({ err, taskId: task.id, branch }, "task-prs: branch PR lookup failed");
    }
  }
  try {
    add(await platform.findPullRequestsByHeadPrefix(ri, `${prefix}${task.id}`));
    checked = true;
  } catch (err) {
    logger.debug({ err, taskId: task.id }, "task-prs: prefix PR lookup failed");
  }
  return { prs: [...found.values()], checked };
}

/** Insert (or refresh) one `task_prs` row. */
export async function upsertTaskPrRow(
  taskId: string,
  repoUrl: string,
  pr: ConfirmedPr,
): Promise<TaskPrRow | null> {
  const [row] = await db
    .insert(taskPrs)
    .values({
      taskId,
      repoUrl,
      number: pr.number,
      url: pr.url,
      headBranch: pr.headBranch,
      headRepo: pr.headRepo,
      baseBranch: pr.baseBranch,
      source: pr.source,
      state: pr.state,
    })
    .onConflictDoUpdate({
      target: [taskPrs.taskId, taskPrs.url],
      // Keep the first source; fill in what a later sighting knows.
      set: {
        state: pr.state,
        updatedAt: new Date(),
        ...(pr.headBranch ? { headBranch: pr.headBranch } : {}),
        ...(pr.headRepo ? { headRepo: pr.headRepo } : {}),
        ...(pr.baseBranch ? { baseBranch: pr.baseBranch } : {}),
      },
    })
    .returning();
  return row ?? null;
}

/** Record the task's primary PR URL (from `updateTaskPr`) when it has no row yet. */
export async function ensurePrimaryPrRow(
  taskId: string,
  repoUrl: string,
  url: string,
  source: TaskPrSource = "branch",
): Promise<void> {
  const number = prNumberFromUrl(url);
  if (number == null) return;
  await db
    .insert(taskPrs)
    .values({ taskId, repoUrl, number, url, source, state: "open" })
    .onConflictDoNothing();
}

/**
 * Record confirmed PRs for a task. The first one becomes `tasks.pr_url` when
 * the task has none; the rest are tracked alongside. A cancelled task adopts
 * nothing. Returns the task's primary PR URL afterwards.
 */
export async function adoptTaskPrs(
  taskId: string,
  confirmed: ConfirmedPr[],
): Promise<{ primaryUrl: string | null; adopted: ConfirmedPr[] }> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return { primaryUrl: null, adopted: [] };
  if (task.state === TaskState.CANCELLED) {
    if (confirmed.length) logger.info({ taskId }, "task-prs: cancelled task adopts no PRs");
    return { primaryUrl: task.prUrl ?? null, adopted: [] };
  }
  const seen = new Set<string>();
  const adopted: ConfirmedPr[] = [];
  for (const pr of confirmed) {
    if (seen.has(pr.url)) continue;
    seen.add(pr.url);
    await upsertTaskPrRow(taskId, task.repoUrl, pr);
    adopted.push(pr);
  }
  let primaryUrl = task.prUrl ?? null;
  if (!primaryUrl && adopted.length > 0) {
    primaryUrl = adopted[0].url;
    await db
      .update(tasks)
      .set({ prUrl: primaryUrl, prNumber: adopted[0].number, updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
  }
  if (adopted.length) {
    logger.info(
      { taskId, prs: adopted.map((p) => `${p.url} (${p.source})`), primaryUrl },
      "task-prs: adopted",
    );
  }
  return { primaryUrl, adopted };
}

/**
 * The whole detection pass for one run: confirm the tool-call candidates,
 * look up branch PRs, adopt them all. `platformChecked` is true when the
 * platform answered the branch lookup (so "no PR" is authoritative).
 */
export async function detectTaskPrs(
  task: TaskRef,
  input: {
    matches: PrToolCallMatch[];
    runStartedAt?: Date | null;
    branches?: string[];
    branchPrefix?: string;
  },
): Promise<{ primaryUrl: string | null; adopted: ConfirmedPr[]; platformChecked: boolean }> {
  const platform = await platformFor(task.repoUrl);
  const fromCalls = await confirmToolCallPrs(task, input.matches, {
    runStartedAt: input.runStartedAt,
    platform,
    branchPrefix: input.branchPrefix,
  });
  const branch = await findBranchPrs(task, {
    branches: input.branches,
    platform,
    branchPrefix: input.branchPrefix,
  });
  const { primaryUrl, adopted } = await adoptTaskPrs(task.id, [...fromCalls, ...branch.prs]);
  return { primaryUrl, adopted, platformChecked: branch.checked };
}

// ── Reads / manual edits (routes) ───────────────────────────────────────────

function toTaskPr(row: TaskPrRow, primaryUrl: string | null, primaryState: string | null): TaskPr {
  const primary = row.url === primaryUrl;
  return {
    id: row.id,
    taskId: row.taskId,
    repoUrl: row.repoUrl,
    number: row.number,
    url: row.url,
    headBranch: row.headBranch,
    headRepo: row.headRepo,
    baseBranch: row.baseBranch,
    source: row.source as TaskPrSource,
    // The PR watcher keeps the primary's state on the task row.
    state: primary && primaryState ? primaryState : row.state,
    primary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every PR of a task, the primary first. */
export async function listTaskPrs(task: {
  id: string;
  prUrl?: string | null;
  prState?: string | null;
}): Promise<TaskPr[]> {
  const rows = await db
    .select()
    .from(taskPrs)
    .where(eq(taskPrs.taskId, task.id))
    .orderBy(asc(taskPrs.createdAt));
  const primaryUrl = task.prUrl ?? null;
  const prs = rows.map((r) => toTaskPr(r, primaryUrl, task.prState ?? null));
  return [...prs.filter((p) => p.primary), ...prs.filter((p) => !p.primary)];
}

export class TaskPrError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "TaskPrError";
  }
}

/**
 * Attach a PR to a task by hand. It must be a PR in the task's repo; the
 * platform is asked for its branches and state when it can be. Becomes the
 * primary when the task has none.
 */
export async function attachTaskPr(
  task: { id: string; repoUrl: string; prUrl?: string | null; state: string },
  url: string,
): Promise<TaskPr> {
  const ri = parseRepoUrl(task.repoUrl);
  const parsed = parsePrUrl(url.trim());
  if (!ri || !parsed) throw new TaskPrError("Not a pull / merge request URL");
  if (!sameRepo(parsed, ri)) {
    throw new TaskPrError(`That PR is not in this task's repository (${ri.owner}/${ri.repo})`);
  }
  if (task.state === TaskState.CANCELLED) {
    throw new TaskPrError("A cancelled task can't track PRs", 409);
  }
  let confirmed: ConfirmedPr = {
    url: url.trim(),
    number: parsed.prNumber,
    headBranch: null,
    headRepo: null,
    baseBranch: null,
    state: "open",
    source: "attached",
  };
  const platform = await platformFor(task.repoUrl);
  if (platform) {
    try {
      const pr = await platform.getPullRequest(ri, parsed.prNumber);
      confirmed = fromPlatform({ ...pr, url: pr.url || confirmed.url }, "attached");
    } catch (err) {
      if (isNotFound(err)) throw new TaskPrError("The git platform has no such PR", 404);
      logger.warn(
        { err, taskId: task.id, url },
        "task-prs: attach lookup failed — attaching as is",
      );
    }
  }
  const { primaryUrl } = await adoptTaskPrs(task.id, [confirmed]);
  const [row] = await db
    .select()
    .from(taskPrs)
    .where(and(eq(taskPrs.taskId, task.id), eq(taskPrs.url, confirmed.url)));
  if (!row) throw new TaskPrError("Could not attach the PR", 409);
  return toTaskPr(row, primaryUrl, null);
}

/**
 * Stop tracking a PR. The primary can only go when another PR can take its
 * place (the oldest remaining one becomes primary).
 */
export async function removeTaskPr(
  task: { id: string; prUrl?: string | null },
  prId: string,
): Promise<{ primaryUrl: string | null }> {
  const rows = await db
    .select()
    .from(taskPrs)
    .where(eq(taskPrs.taskId, task.id))
    .orderBy(asc(taskPrs.createdAt));
  const row = rows.find((r) => r.id === prId);
  if (!row) throw new TaskPrError("PR not found on this task", 404);
  let primaryUrl = task.prUrl ?? null;
  if (row.url === primaryUrl) {
    const next = rows.find((r) => r.id !== prId);
    if (!next) {
      throw new TaskPrError(
        "This is the task's only PR — it can't stop tracking it without another to follow",
        409,
      );
    }
    primaryUrl = next.url;
    await db
      .update(tasks)
      .set({
        prUrl: next.url,
        prNumber: next.number,
        prState: next.state,
        prChecksStatus: null,
        prReviewStatus: null,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
  }
  await db.delete(taskPrs).where(and(eq(taskPrs.id, prId), eq(taskPrs.taskId, task.id)));
  return { primaryUrl };
}
