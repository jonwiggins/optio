import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  tasks,
  workflowRuns,
  workflows,
  repoPods,
  repos,
  taskEvents,
  workflowPods,
  prReviews,
  prReviewRuns,
  prReviewEvents,
  persistentAgents,
  persistentAgentMessages,
  persistentAgentPods,
  persistentAgentTurns,
} from "../db/schema.js";
import {
  TaskState,
  WorkflowRunState,
  PrReviewState,
  PrReviewRunState,
  PersistentAgentState,
  PersistentAgentPodLifecycle,
  DEFAULT_STALL_THRESHOLD_MS,
  getOffPeakInfo,
  parseIntEnv,
  parsePrUrl,
} from "@optio/shared";
import type {
  RunRef,
  Run,
  WorldSnapshot,
  WorldReadError,
  PrStatus,
  PodStatus,
  DependencyObservation,
  RepoRunSpec,
  RepoRunStatus,
  StandaloneRunSpec,
  StandaloneRunStatus,
  PrReviewRunSpec,
  PrReviewRunStatus,
  PrReviewControlIntent,
  PrReviewRunKind,
  PersistentAgentRunSpec,
  PersistentAgentRunStatus,
  PersistentAgentControlIntent,
} from "@optio/shared";
import { getGitPlatformForRepo } from "./git-token-service.js";
import { determineCheckStatus, determineReviewStatus } from "../workers/pr-watcher-worker.js";
import { checkBlockingSubtasks } from "./subtask-service.js";
import { logger } from "../logger.js";

/**
 * Build a WorldSnapshot for a given run.
 *
 * All reads happen up-front; the snapshot is then frozen and passed into the
 * pure decision function. Any read failure is recorded in readErrors so the
 * decision function can choose to defer rather than act on stale truth.
 */
export async function buildWorldSnapshot(ref: RunRef): Promise<WorldSnapshot | null> {
  if (ref.kind === "repo") return buildRepoSnapshot(ref);
  if (ref.kind === "pr-review") return buildPrReviewSnapshot(ref);
  if (ref.kind === "persistent-agent") return buildPersistentAgentSnapshot(ref);
  return buildStandaloneSnapshot(ref);
}

// ── Repo snapshot ───────────────────────────────────────────────────────────

async function buildRepoSnapshot(ref: RunRef): Promise<WorldSnapshot | null> {
  const readErrors: WorldReadError[] = [];
  const now = new Date();

  const [row] = await db.select().from(tasks).where(eq(tasks.id, ref.id));
  if (!row) return null;

  const run = loadRepoRun(row, ref);

  // Fetch dependents, blocking subtasks, capacity, and PR status in parallel.
  const [
    deps,
    subtaskCounts,
    globalCap,
    repoCap,
    prResult,
    podResult,
    repoConfig,
    recentAutoResumeCount,
  ] = await Promise.all([
    loadDependencies(ref.id).catch((err) => {
      readErrors.push({ source: "deps", message: String(err) });
      return [] as DependencyObservation[];
    }),
    loadBlockingSubtasks(ref.id).catch((err) => {
      readErrors.push({ source: "deps", message: String(err) });
      return [] as DependencyObservation[];
    }),
    loadGlobalRepoCapacity().catch((err) => {
      readErrors.push({ source: "capacity", message: String(err) });
      return null;
    }),
    loadPerRepoCapacity(row.repoUrl, row.workspaceId ?? null).catch((err) => {
      readErrors.push({ source: "capacity", message: String(err) });
      return null;
    }),
    // Only coding tasks own a PR. "review" subtasks and external "pr_review"
    // tasks reference PRs through other tables (parent task / review_drafts),
    // so never load PR status for them — that's what keeps them out of the
    // PR-reactive state machine (auto-merge, auto-resume, launch-review).
    row.taskType !== "coding" && row.taskType !== null
      ? Promise.resolve(null)
      : loadPrStatus(run, row.createdBy ?? null).catch((err) => {
          readErrors.push({ source: "pr", message: String(err) });
          return null;
        }),
    loadPodStatusForRepo(row.lastPodId ?? null).catch((err) => {
      readErrors.push({ source: "pod", message: String(err) });
      return null;
    }),
    loadRepoSettings(row.repoUrl, row.workspaceId ?? null).catch((err) => {
      readErrors.push({ source: "capacity", message: String(err) });
      return null;
    }),
    countRecentAutoResumes(ref.id).catch(() => 0),
  ]);

  const stallThresholdMs = parseIntEnv("OPTIO_STALL_THRESHOLD_MS", DEFAULT_STALL_THRESHOLD_MS);
  const heartbeat = computeHeartbeat(
    row.lastActivityAt ?? null,
    row.state === TaskState.RUNNING,
    stallThresholdMs,
    now,
  );

  const offPeak = getOffPeakInfo(now);
  const hasReviewSubtask = subtaskCounts.some(
    (s) => s.state !== TaskState.FAILED && s.blocksParent,
  );

  const snapshot: WorldSnapshot = {
    now,
    run,
    pod: podResult,
    pr: prResult,
    dependencies: deps,
    blockingSubtasks: subtaskCounts,
    capacity: {
      global: globalCap ?? { running: 0, max: parseIntEnv("OPTIO_MAX_CONCURRENT", 5) },
      repo: repoCap ?? undefined,
    },
    heartbeat,
    settings: {
      stallThresholdMs,
      autoMerge: repoConfig?.autoMerge ?? false,
      cautiousMode: repoConfig?.cautiousMode ?? false,
      autoResume: repoConfig?.autoResume ?? false,
      reviewEnabled: repoConfig?.reviewEnabled ?? false,
      reviewTrigger:
        repoConfig?.reviewTrigger === "on_pr" || repoConfig?.reviewTrigger === "on_ci_pass"
          ? (repoConfig.reviewTrigger as "on_pr" | "on_ci_pass")
          : null,
      offPeakOnly: repoConfig?.offPeakOnly ?? false,
      offPeakActive: offPeak.isOffPeak,
      hasReviewSubtask,
      maxAutoResumes: repoConfig?.maxAutoResumes ?? parseIntEnv("OPTIO_MAX_AUTO_RESUMES", 10),
      recentAutoResumeCount,
    },
    readErrors,
  };

  return Object.freeze(snapshot);
}

/**
 * Count auto_resume_* events for this task since the last manual action
 * (force_restart, user_resume, etc.). Used by decideFromPrStatus to cap
 * resumeAgent firing.
 */
async function countRecentAutoResumes(taskId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskEvents)
    .where(
      sql`${taskEvents.taskId} = ${taskId}
        AND ${taskEvents.trigger} LIKE 'auto_resume_%'
        AND ${taskEvents.createdAt} > COALESCE(
          (SELECT MAX(te2.created_at) FROM task_events te2
           WHERE te2.task_id = ${taskId}
           AND te2.trigger IN ('force_restart', 'user_resume', 'force_redo', 'user_retry', 'issue_assigned')),
          '1970-01-01'::timestamptz
        )`,
    );
  return Number(count);
}

function loadRepoRun(row: typeof tasks.$inferSelect, ref: RunRef): Run {
  const spec: RepoRunSpec = {
    repoUrl: row.repoUrl,
    repoBranch: row.repoBranch,
    agentType: row.agentType,
    prompt: row.prompt,
    title: row.title,
    taskType: (row.taskType as "coding" | "review") ?? "coding",
    maxRetries: row.maxRetries,
    priority: row.priority,
    ignoreOffPeak: row.ignoreOffPeak,
    parentTaskId: row.parentTaskId ?? null,
    blocksParent: row.blocksParent,
    workspaceId: row.workspaceId ?? null,
    workflowRunId: row.workflowRunId ?? null,
  };
  const status: RepoRunStatus = {
    state: row.state as TaskState,
    prUrl: row.prUrl ?? null,
    prNumber: row.prNumber ?? null,
    prState: (row.prState as RepoRunStatus["prState"]) ?? null,
    prChecksStatus: (row.prChecksStatus as RepoRunStatus["prChecksStatus"]) ?? null,
    prReviewStatus: (row.prReviewStatus as RepoRunStatus["prReviewStatus"]) ?? null,
    prReviewComments: row.prReviewComments ?? null,
    containerId: row.containerId ?? null,
    sessionId: row.sessionId ?? null,
    worktreeState: row.worktreeState ?? null,
    lastPodId: row.lastPodId ?? null,
    lastActivityAt: row.lastActivityAt ?? null,
    retryCount: row.retryCount,
    errorMessage: row.errorMessage ?? null,
    costUsd: row.costUsd ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    controlIntent:
      row.controlIntent === "cancel" ||
      row.controlIntent === "retry" ||
      row.controlIntent === "resume" ||
      row.controlIntent === "restart"
        ? row.controlIntent
        : null,
    reconcileBackoffUntil: row.reconcileBackoffUntil ?? null,
    reconcileAttempts: row.reconcileAttempts ?? 0,
    updatedAt: row.updatedAt,
  };
  return { kind: "repo", ref, spec, status };
}

async function loadDependencies(taskId: string): Promise<DependencyObservation[]> {
  // Lazy import to avoid circular references.
  const { getDependencies } = await import("./dependency-service.js");
  const deps = await getDependencies(taskId).catch(() => [] as unknown[]);
  return (deps as { id?: string; state?: TaskState }[])
    .filter((d) => typeof d.id === "string" && typeof d.state === "string")
    .map((d) => ({
      taskId: d.id as string,
      state: d.state as TaskState,
      blocksParent: false,
    }));
}

async function loadBlockingSubtasks(parentTaskId: string): Promise<DependencyObservation[]> {
  const status = await checkBlockingSubtasks(parentTaskId);
  if (status.total === 0) return [];
  // checkBlockingSubtasks returns counts only; for accurate decisions we need
  // per-subtask state. Fetch them directly.
  const rows = await db
    .select({
      id: tasks.id,
      state: tasks.state,
      blocksParent: tasks.blocksParent,
    })
    .from(tasks)
    .where(and(eq(tasks.parentTaskId, parentTaskId), eq(tasks.blocksParent, true)));
  return rows.map((r) => ({
    taskId: r.id,
    state: r.state as TaskState,
    blocksParent: r.blocksParent,
  }));
}

async function loadGlobalRepoCapacity() {
  const max = parseIntEnv("OPTIO_MAX_CONCURRENT", 5);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(sql`${tasks.state} IN ('running', 'provisioning')`);
  return { running: Number(count), max };
}

async function loadPerRepoCapacity(repoUrl: string, workspaceId: string | null) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(sql`${tasks.state} IN ('running', 'provisioning') AND ${tasks.repoUrl} = ${repoUrl}`);
  const repoRow = await loadRepoSettings(repoUrl, workspaceId);
  const max = repoRow?.maxConcurrentTasks ?? 2;
  return { running: Number(count), max };
}

async function loadPrStatus(run: Run, userId: string | null): Promise<PrStatus | null> {
  if (run.kind !== "repo") return null;
  const { status, spec } = run;
  if (!status.prUrl) return null;
  const parsed = parsePrUrl(status.prUrl);
  if (!parsed) return null;

  const platformResult = await getGitPlatformForRepo(spec.repoUrl, {
    userId: userId ?? undefined,
  }).catch(() => null);
  if (!platformResult) return null;
  const { platform, ri } = platformResult;

  const prData = await platform.getPullRequest(ri, parsed.prNumber).catch(() => null);
  if (!prData) return null;

  const [checkRuns, reviews] = await Promise.all([
    platform.getCIChecks(ri, prData.headSha).catch(() => []),
    platform.getReviews(ri, parsed.prNumber).catch(() => []),
  ]);
  const checksStatus = determineCheckStatus(checkRuns);
  const reviewResult = determineReviewStatus(reviews);

  return {
    url: status.prUrl,
    number: parsed.prNumber,
    state: (prData.merged ? "merged" : prData.state) as PrStatus["state"],
    merged: !!prData.merged,
    mergeable: prData.mergeable ?? null,
    checksStatus,
    reviewStatus: reviewResult.status as PrStatus["reviewStatus"],
    latestReviewComments: reviewResult.comments || null,
    headSha: prData.headSha ?? null,
  };
}

async function loadPodStatusForWorkflowRun(runId: string): Promise<PodStatus | null> {
  // Runs now share pods across a workflow; find the assigned pod via the
  // `pod_id` pointer on workflow_runs. Null when the run has been released
  // (terminal) or hasn't been scheduled onto a pod yet.
  const [runRow] = await db
    .select({ podId: workflowRuns.podId })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  if (!runRow?.podId) return null;

  const [pod] = await db
    .select()
    .from(workflowPods)
    .where(eq(workflowPods.id, runRow.podId))
    .limit(1);
  if (!pod) return null;
  return {
    podName: pod.podName ?? pod.id,
    phase: mapWorkflowPodPhase(pod.state),
    lastError: pod.errorMessage ?? null,
  };
}

function mapWorkflowPodPhase(state: string): PodStatus["phase"] {
  switch (state) {
    case "provisioning":
      return "pending";
    case "ready":
      return "ready";
    case "error":
      return "error";
    case "terminating":
      return "terminated";
    default:
      return "unknown";
  }
}

async function loadPodStatusForRepo(podId: string | null): Promise<PodStatus | null> {
  if (!podId) return null;
  const [row] = await db.select().from(repoPods).where(eq(repoPods.id, podId));
  if (!row) return null;
  const phase = mapRepoPodPhase(row.state);
  return {
    podName: row.podName ?? podId,
    phase,
    lastError: row.errorMessage ?? null,
  };
}

function mapRepoPodPhase(state: string): PodStatus["phase"] {
  switch (state) {
    case "provisioning":
      return "pending";
    case "ready":
      return "ready";
    case "error":
      return "error";
    case "terminating":
    case "terminated":
      return "terminated";
    default:
      return "unknown";
  }
}

async function loadRepoSettings(repoUrl: string, workspaceId: string | null) {
  const conditions = [eq(repos.repoUrl, repoUrl)];
  if (workspaceId) conditions.push(eq(repos.workspaceId, workspaceId));
  const [row] = await db
    .select()
    .from(repos)
    .where(and(...conditions))
    .limit(1);
  if (!row) return null;
  return {
    autoMerge: row.autoMerge ?? false,
    cautiousMode: row.cautiousMode ?? false,
    autoResume: row.autoResume ?? false,
    reviewEnabled: row.reviewEnabled ?? false,
    reviewTrigger: row.reviewTrigger ?? null,
    offPeakOnly: row.offPeakOnly ?? false,
    maxConcurrentTasks: row.maxConcurrentTasks ?? 2,
    maxAutoResumes: row.maxAutoResumes ?? null,
  };
}

// ── Standalone snapshot ─────────────────────────────────────────────────────

async function buildStandaloneSnapshot(ref: RunRef): Promise<WorldSnapshot | null> {
  const readErrors: WorldReadError[] = [];
  const now = new Date();

  const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, ref.id));
  if (!row) return null;

  const [workflowRow] = await db.select().from(workflows).where(eq(workflows.id, row.workflowId));
  if (!workflowRow) {
    logger.warn({ runId: ref.id, workflowId: row.workflowId }, "workflow not found for run");
    return null;
  }

  const run = loadStandaloneRun(row, workflowRow, ref);

  const [globalCap, workflowCap, podResult] = await Promise.all([
    loadGlobalWorkflowCapacity().catch((err) => {
      readErrors.push({ source: "capacity", message: String(err) });
      return null;
    }),
    loadPerWorkflowCapacity(row.workflowId, workflowRow.maxConcurrent).catch((err) => {
      readErrors.push({ source: "capacity", message: String(err) });
      return null;
    }),
    loadPodStatusForWorkflowRun(ref.id).catch((err) => {
      readErrors.push({ source: "pod", message: String(err) });
      return null;
    }),
  ]);

  const stallThresholdMs = parseIntEnv("OPTIO_STALL_THRESHOLD_MS", DEFAULT_STALL_THRESHOLD_MS);
  // workflow_runs doesn't have lastActivityAt — use startedAt for
  // coarse stall detection until a richer signal exists.
  if (run.kind !== "standalone") {
    throw new Error("expected standalone run for standalone snapshot");
  }
  const heartbeat = computeHeartbeat(
    run.status.startedAt,
    run.status.state === WorkflowRunState.RUNNING,
    stallThresholdMs,
    now,
  );

  const snapshot: WorldSnapshot = {
    now,
    run,
    pod: podResult,
    pr: null,
    dependencies: [],
    blockingSubtasks: [],
    capacity: {
      global: globalCap ?? {
        running: 0,
        max: parseIntEnv("OPTIO_MAX_WORKFLOW_CONCURRENT", 5),
      },
      repo: workflowCap ?? undefined,
    },
    heartbeat,
    settings: {
      stallThresholdMs,
      autoMerge: false,
      cautiousMode: false,
      autoResume: false,
      reviewEnabled: false,
      reviewTrigger: null,
      offPeakOnly: false,
      offPeakActive: false,
      hasReviewSubtask: false,
      maxAutoResumes: 0,
      recentAutoResumeCount: 0,
    },
    readErrors,
  };

  return Object.freeze(snapshot);
}

function loadStandaloneRun(
  row: typeof workflowRuns.$inferSelect,
  workflowRow: typeof workflows.$inferSelect,
  ref: RunRef,
): Run {
  const spec: StandaloneRunSpec = {
    workflowId: workflowRow.id,
    workflowEnabled: workflowRow.enabled,
    agentRuntime: workflowRow.agentRuntime,
    promptRendered: workflowRow.promptTemplate,
    params: row.params ?? null,
    maxConcurrent: workflowRow.maxConcurrent,
    maxRetries: workflowRow.maxRetries,
    workspaceId: workflowRow.workspaceId ?? null,
  };
  const status: StandaloneRunStatus = {
    state: row.state as WorkflowRunState,
    costUsd: row.costUsd ?? null,
    errorMessage: row.errorMessage ?? null,
    sessionId: row.sessionId ?? null,
    podName: row.podName ?? null,
    retryCount: row.retryCount,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    controlIntent:
      row.controlIntent === "cancel" ||
      row.controlIntent === "retry" ||
      row.controlIntent === "resume" ||
      row.controlIntent === "restart"
        ? row.controlIntent
        : null,
    reconcileBackoffUntil: row.reconcileBackoffUntil ?? null,
    reconcileAttempts: row.reconcileAttempts ?? 0,
    updatedAt: row.updatedAt,
  };
  return { kind: "standalone", ref, spec, status };
}

async function loadGlobalWorkflowCapacity() {
  const max = parseIntEnv("OPTIO_MAX_WORKFLOW_CONCURRENT", 5);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowRuns)
    .where(eq(workflowRuns.state, WorkflowRunState.RUNNING));
  return { running: Number(count), max };
}

async function loadPerWorkflowCapacity(workflowId: string, max: number) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowRuns)
    .where(
      sql`${workflowRuns.state} = ${WorkflowRunState.RUNNING} AND ${workflowRuns.workflowId} = ${workflowId}`,
    );
  return { running: Number(count), max };
}

// ── Heartbeat helper ────────────────────────────────────────────────────────

function computeHeartbeat(
  lastActivityAt: Date | null,
  isRunning: boolean,
  thresholdMs: number,
  now: Date,
) {
  if (!isRunning || !lastActivityAt) {
    return {
      lastActivityAt,
      isStale: false,
      silentForMs: 0,
    };
  }
  const silentForMs = Math.max(0, now.getTime() - lastActivityAt.getTime());
  return {
    lastActivityAt,
    isStale: silentForMs >= thresholdMs,
    silentForMs,
  };
}

// ── PR Review snapshot ──────────────────────────────────────────────────────

async function buildPrReviewSnapshot(ref: RunRef): Promise<WorldSnapshot | null> {
  const readErrors: WorldReadError[] = [];
  const now = new Date();

  const [row] = await db.select().from(prReviews).where(eq(prReviews.id, ref.id));
  if (!row) return null;

  const repoConfig = await loadRepoSettings(row.repoUrl, row.workspaceId ?? null);
  const maxAutoRereviews = repoConfig?.maxAutoResumes ?? parseIntEnv("OPTIO_MAX_AUTO_RESUMES", 10);

  const run: Run = {
    kind: "pr-review",
    ref,
    spec: buildPrReviewSpec(row, {
      autoSubmitOnReady: false, // read below
      maxAutoRereviews,
    }),
    status: await buildPrReviewStatus(row),
  };

  // Auto-submit is encoded in repos.externalReviewMode === 'on_pr_post'.
  const repoRowFull = await db.select().from(repos).where(eq(repos.repoUrl, row.repoUrl)).limit(1);
  const autoSubmitOnReady = repoRowFull[0]?.externalReviewMode === "on_pr_post";
  const specWithAuto: PrReviewRunSpec = {
    ...(run.spec as PrReviewRunSpec),
    autoSubmitOnReady,
  };
  const runWithAuto: Run = { ...run, spec: specWithAuto } as Run;

  const [prResult, recentAutoRereviewCount] = await Promise.all([
    loadPrStatusForReview(row).catch((err) => {
      readErrors.push({ source: "pr", message: String(err) });
      return null;
    }),
    countRecentAutoRereviews(row.id).catch(() => 0),
  ]);

  const stallThresholdMs = parseIntEnv("OPTIO_STALL_THRESHOLD_MS", DEFAULT_STALL_THRESHOLD_MS);

  const snapshot: WorldSnapshot = {
    now,
    run: runWithAuto,
    pod: null,
    pr: prResult,
    dependencies: [],
    blockingSubtasks: [],
    capacity: {
      global: { running: 0, max: parseIntEnv("OPTIO_PR_REVIEW_CONCURRENCY", 4) },
    },
    heartbeat: { lastActivityAt: null, isStale: false, silentForMs: 0 },
    settings: {
      stallThresholdMs,
      autoMerge: false,
      cautiousMode: false,
      autoResume: false,
      reviewEnabled: true,
      reviewTrigger: null,
      offPeakOnly: false,
      offPeakActive: false,
      hasReviewSubtask: false,
      maxAutoResumes: maxAutoRereviews,
      recentAutoResumeCount: recentAutoRereviewCount,
    },
    readErrors,
  };

  return Object.freeze(snapshot);
}

function buildPrReviewSpec(
  row: typeof prReviews.$inferSelect,
  extras: { autoSubmitOnReady: boolean; maxAutoRereviews: number },
): PrReviewRunSpec {
  return {
    prUrl: row.prUrl,
    prNumber: row.prNumber,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    repoUrl: row.repoUrl,
    workspaceId: row.workspaceId ?? null,
    origin: (row.origin as PrReviewRunSpec["origin"]) ?? "manual",
    userEngaged: row.userEngaged,
    autoSubmitted: row.autoSubmitted,
    headSha: row.headSha,
    autoSubmitOnReady: extras.autoSubmitOnReady,
    maxAutoRereviews: extras.maxAutoRereviews,
  };
}

async function buildPrReviewStatus(row: typeof prReviews.$inferSelect): Promise<PrReviewRunStatus> {
  const [latestRun] = await db
    .select()
    .from(prReviewRuns)
    .where(eq(prReviewRuns.prReviewId, row.id))
    .orderBy(desc(prReviewRuns.createdAt))
    .limit(1);

  return {
    state: row.state as PrReviewState,
    verdict: (row.verdict as PrReviewRunStatus["verdict"]) ?? null,
    summary: row.summary ?? null,
    fileComments: (row.fileComments as PrReviewRunStatus["fileComments"]) ?? null,
    submittedAt: row.submittedAt ?? null,
    errorMessage: row.errorMessage ?? null,
    controlIntent:
      row.controlIntent === "cancel" || row.controlIntent === "rereview"
        ? (row.controlIntent as PrReviewControlIntent)
        : null,
    latestRunKind: (latestRun?.kind as PrReviewRunKind) ?? null,
    latestRunState: (latestRun?.state as PrReviewRunState) ?? null,
    // Seeded downstream via settings.recentAutoResumeCount.
    recentAutoRereviewCount: 0,
    reconcileBackoffUntil: row.reconcileBackoffUntil ?? null,
    reconcileAttempts: row.reconcileAttempts ?? 0,
    updatedAt: row.updatedAt,
  };
}

async function loadPrStatusForReview(row: typeof prReviews.$inferSelect): Promise<PrStatus | null> {
  const parsed = parsePrUrl(row.prUrl);
  if (!parsed) return null;
  const platformResult = await getGitPlatformForRepo(row.repoUrl, { server: true }).catch(
    () => null,
  );
  if (!platformResult) return null;
  const { platform, ri } = platformResult;

  const prData = await platform.getPullRequest(ri, parsed.prNumber).catch(() => null);
  if (!prData) return null;

  const [checkRuns, reviews] = await Promise.all([
    platform.getCIChecks(ri, prData.headSha).catch(() => []),
    platform.getReviews(ri, parsed.prNumber).catch(() => []),
  ]);
  const checksStatus = determineCheckStatus(checkRuns);
  const reviewResult = determineReviewStatus(reviews);

  return {
    url: row.prUrl,
    number: parsed.prNumber,
    state: (prData.merged ? "merged" : prData.state) as PrStatus["state"],
    merged: !!prData.merged,
    mergeable: prData.mergeable ?? null,
    checksStatus,
    reviewStatus: reviewResult.status as PrStatus["reviewStatus"],
    latestReviewComments: reviewResult.comments || null,
    headSha: prData.headSha ?? null,
  };
}

async function countRecentAutoRereviews(prReviewId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(prReviewEvents)
    .where(
      sql`${prReviewEvents.prReviewId} = ${prReviewId}
        AND ${prReviewEvents.trigger} LIKE 'auto_rereview_%'
        AND ${prReviewEvents.createdAt} > COALESCE(
          (SELECT MAX(e2.created_at) FROM pr_review_events e2
           WHERE e2.pr_review_id = ${prReviewId}
           AND e2.trigger IN ('user_rereview', 'user_submit', 'user_relaunch', 'user_cancel')),
          '1970-01-01'::timestamptz
        )`,
    );
  return Number(count);
}

// ── Persistent Agent snapshot ──────────────────────────────────────────────

async function buildPersistentAgentSnapshot(ref: RunRef): Promise<WorldSnapshot | null> {
  const readErrors: WorldReadError[] = [];
  const now = new Date();

  const [row] = await db.select().from(persistentAgents).where(eq(persistentAgents.id, ref.id));
  if (!row) return null;

  const [globalCap, podRow, inbox, lastTurn] = await Promise.all([
    loadGlobalPersistentAgentCapacity().catch((err) => {
      readErrors.push({ source: "capacity", message: String(err) });
      return null;
    }),
    loadActivePodForPersistentAgent(ref.id).catch((err) => {
      readErrors.push({ source: "pod", message: String(err) });
      return null;
    }),
    loadInboxSummary(ref.id).catch((err) => {
      readErrors.push({ source: "deps", message: String(err) });
      return { pending: 0, oldest: null as Date | null };
    }),
    loadLastRunningTurn(ref.id).catch(() => null),
  ]);

  const spec: PersistentAgentRunSpec = {
    agentId: row.id,
    slug: row.slug,
    workspaceId: row.workspaceId ?? null,
    agentRuntime: row.agentRuntime,
    enabled: row.enabled,
    podLifecycle: row.podLifecycle as PersistentAgentPodLifecycle,
    idlePodTimeoutMs: row.idlePodTimeoutMs,
    consecutiveFailureLimit: row.consecutiveFailureLimit,
    maxTurnDurationMs: row.maxTurnDurationMs,
  };

  const status: PersistentAgentRunStatus = {
    state: row.state as PersistentAgentState,
    errorMessage: row.lastFailureReason ?? null,
    sessionId: row.sessionId ?? null,
    consecutiveFailures: row.consecutiveFailures,
    lastFailureAt: row.lastFailureAt ?? null,
    lastFailureReason: row.lastFailureReason ?? null,
    lastTurnAt: row.lastTurnAt ?? null,
    totalCostUsd: row.totalCostUsd ?? "0",
    controlIntent:
      row.controlIntent === "pause" ||
      row.controlIntent === "resume" ||
      row.controlIntent === "archive" ||
      row.controlIntent === "restart"
        ? (row.controlIntent as PersistentAgentControlIntent)
        : null,
    reconcileBackoffUntil: row.reconcileBackoffUntil ?? null,
    reconcileAttempts: row.reconcileAttempts ?? 0,
    updatedAt: row.updatedAt,
    pendingMessages: inbox.pending,
    oldestPendingAt: inbox.oldest,
  };

  const stallThresholdMs = row.maxTurnDurationMs;
  const heartbeat = computeHeartbeat(
    lastTurn?.startedAt ?? null,
    row.state === PersistentAgentState.RUNNING,
    stallThresholdMs,
    now,
  );

  const run: Run = { kind: "persistent-agent", ref, spec, status };

  const snapshot: WorldSnapshot = {
    now,
    run,
    pod: podRow,
    pr: null,
    dependencies: [],
    blockingSubtasks: [],
    capacity: {
      global: globalCap ?? {
        running: 0,
        max: parseIntEnv("OPTIO_MAX_PERSISTENT_AGENTS_RUNNING", 10),
      },
    },
    heartbeat,
    settings: {
      stallThresholdMs,
      autoMerge: false,
      cautiousMode: false,
      autoResume: false,
      reviewEnabled: false,
      reviewTrigger: null,
      offPeakOnly: false,
      offPeakActive: false,
      hasReviewSubtask: false,
      maxAutoResumes: 0,
      recentAutoResumeCount: 0,
    },
    readErrors,
  };
  return Object.freeze(snapshot);
}

async function loadGlobalPersistentAgentCapacity() {
  const max = parseIntEnv("OPTIO_MAX_PERSISTENT_AGENTS_RUNNING", 10);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(persistentAgents)
    .where(eq(persistentAgents.state, PersistentAgentState.RUNNING));
  return { running: Number(count), max };
}

async function loadActivePodForPersistentAgent(agentId: string): Promise<PodStatus | null> {
  const [pod] = await db
    .select()
    .from(persistentAgentPods)
    .where(eq(persistentAgentPods.agentId, agentId))
    .orderBy(desc(persistentAgentPods.updatedAt))
    .limit(1);
  if (!pod || !pod.podName) return null;
  return {
    podName: pod.podName,
    phase: mapWorkflowPodPhase(pod.state),
    lastError: pod.errorMessage ?? null,
  };
}

async function loadInboxSummary(agentId: string) {
  const [row] = await db
    .select({
      pending: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`MIN(${persistentAgentMessages.receivedAt})`,
    })
    .from(persistentAgentMessages)
    .where(
      and(
        eq(persistentAgentMessages.agentId, agentId),
        isNull(persistentAgentMessages.processedAt),
      ),
    );
  return {
    pending: Number(row?.pending ?? 0),
    oldest: (row?.oldest as Date | null) ?? null,
  };
}

async function loadLastRunningTurn(agentId: string) {
  const [row] = await db
    .select()
    .from(persistentAgentTurns)
    .where(and(eq(persistentAgentTurns.agentId, agentId), isNull(persistentAgentTurns.finishedAt)))
    .orderBy(desc(persistentAgentTurns.turnNumber))
    .limit(1);
  return row ?? null;
}
