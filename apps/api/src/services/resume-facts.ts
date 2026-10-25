import { eq } from "drizzle-orm";
import { parsePrUrl, parseRepoUrl, type WorldSnapshot } from "@optio/shared";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import { getGitToken } from "./git-token-service.js";
import { createGitPlatform } from "./git-platform/index.js";
import { fetchFailedJobLogs, type FailedJobs } from "./git-platform/gitlab-ci-logs.js";
import { fetchFailedGitHubJobLogs } from "./git-platform/github-ci-logs.js";
import { logger } from "../logger.js";

/**
 * What an automatic resume tells the agent beyond upstream's fixed wording
 * (reconcile-executor.ts `buildResumeContext` calls this):
 *
 * - **conflicts**: the branch to rebase onto is the MR's own target branch.
 *   Upstream says `git rebase origin/main` whatever the repo, so a repo whose
 *   MRs go to master, develop or a release branch was rebased onto the wrong
 *   branch (upstream fixed the same class at task start, #643, not here).
 *   Without an answer from the platform: the branch the task started from.
 * - **ci_failure**: the failed jobs' names, stages and the last lines of
 *   their logs, secrets masked, so the agent starts from the error instead
 *   of hunting for it — GitLab's pipeline (git-platform/gitlab-ci-logs.ts)
 *   unless `OPTIO_CI_FAILURE_LOGS=false`, and GitHub Actions
 *   (git-platform/github-ci-logs.ts) only when `OPTIO_CI_FAILURE_LOGS=true`
 *   (`ciFailureLogsEnabled`).
 *
 * Everything here is best effort and bounded in time: the resume waits for
 * these reads at most `FACTS_TIMEOUT_MS`, well under the reconcile job's lock
 * (`OPTIO_RECONCILE_LOCK_MS`, 30 s), and on any failure goes ahead with the
 * fallback (upstream's CI wording, the task's own branch). The executor
 * re-checks the task's version after the wait, so a pass that read an older
 * snapshot doesn't resume the task a second time.
 */

export interface ResumeFacts {
  /** The branch the MR merges into (the task's branch when unknown). */
  targetBranch: string;
  /** The failed pipeline's jobs and log tails (CI resumes only; `ciFailureLogsEnabled`). */
  ciFailure?: FailedJobs | null;
}

/**
 * Whether a CI-fix resume reads the failed jobs' logs on `platform`:
 * `OPTIO_CI_FAILURE_LOGS=true` for every platform, `false` for none; unset,
 * GitLab's only (a GitHub repo's resume keeps upstream's wording).
 */
export function ciFailureLogsEnabled(
  platform: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = (env.OPTIO_CI_FAILURE_LOGS ?? "").trim().toLowerCase();
  if (flag === "true") return platform === "gitlab" || platform === "github";
  if (flag === "false") return false;
  return platform === "gitlab";
}

/** How long a resume waits for these reads before using the fallback. */
export const FACTS_TIMEOUT_MS = 15_000;

export async function loadResumeFacts(
  snapshot: WorldSnapshot,
  reason: "ci_failure" | "conflicts" | "review",
): Promise<ResumeFacts> {
  const run = snapshot.run;
  const fallback: ResumeFacts = {
    targetBranch: (run.kind === "repo" && run.spec.repoBranch) || "main",
  };
  if (run.kind !== "repo" || reason === "review" || !run.status.prUrl) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), FACTS_TIMEOUT_MS);
    });
    return await Promise.race([gather(snapshot, reason, fallback), timeout]);
  } catch (err) {
    logger.warn(
      { taskId: run.ref.id, reason, err: err instanceof Error ? err.message : String(err) },
      "Resume: could not read the MR's target branch or failed jobs; using the fallback",
    );
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function gather(
  snapshot: WorldSnapshot,
  reason: "ci_failure" | "conflicts",
  fallback: ResumeFacts,
): Promise<ResumeFacts> {
  const run = snapshot.run;
  if (run.kind !== "repo" || !run.status.prUrl) return fallback;
  const pr = parsePrUrl(run.status.prUrl);
  const ri = parseRepoUrl(run.spec.repoUrl);
  if (!pr || !ri) return fallback;

  // The task's own token context, as the watcher reads the MR
  // (reconcile-snapshot.ts loadPrStatus): its creator, workspace and team.
  const [row] = await db
    .select({
      createdBy: tasks.createdBy,
      workspaceId: tasks.workspaceId,
      ownerTeamId: tasks.ownerTeamId,
    })
    .from(tasks)
    .where(eq(tasks.id, run.ref.id));
  const token = await getGitToken(ri.platform, {
    userId: row?.createdBy ?? undefined,
    workspaceId: row?.workspaceId ?? run.spec.workspaceId,
    ownerTeamId: row?.ownerTeamId ?? null,
    host: ri.host,
  });
  const platform = createGitPlatform(ri.platform, token);
  const mr = await platform.getPullRequest(ri, pr.prNumber);
  const facts: ResumeFacts = { targetBranch: mr.baseBranch || fallback.targetBranch };

  const headSha = mr.headSha || snapshot.pr?.headSha;
  if (reason === "ci_failure" && headSha && ciFailureLogsEnabled(ri.platform)) {
    // Without the logs the resume still gets the target branch.
    const read =
      ri.platform === "gitlab"
        ? fetchFailedJobLogs(ri, token, headSha, { mrIid: pr.prNumber })
        : fetchFailedGitHubJobLogs(ri, token, headSha);
    facts.ciFailure = await read.catch((err) => {
      logger.warn(
        { taskId: run.ref.id, err: err instanceof Error ? err.message : String(err) },
        "Resume: could not read the failed jobs' logs",
      );
      return null;
    });
  }
  return facts;
}
