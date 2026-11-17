import type { RepoIdentifier } from "@optio/shared";
import { guardedFetch } from "../../utils/outbound-url.js";
import { GitHubApiError } from "./github.js";
import { GitLabApiError } from "./gitlab.js";

/**
 * The pull-request panel's one-click actions that the GitPlatform interface
 * doesn't cover: bring a branch up to date with its base, and re-run the
 * failed CI of a PR's head. GitHub and GitLab; CodeCommit has neither.
 */

export class PrQuickActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

async function github(
  ri: RepoIdentifier,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  fetchImpl: Fetch = fetch,
): Promise<any> {
  const res = await fetchImpl(`${ri.apiBaseUrl}/repos/${ri.owner}/${ri.repo}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "Optio",
      Accept: "application/vnd.github+json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw GitHubApiError.fromResponse(res, text);
  return text ? JSON.parse(text) : null;
}

async function gitlab(
  ri: RepoIdentifier,
  token: string,
  path: string,
  method = "GET",
): Promise<any> {
  const project = encodeURIComponent(`${ri.owner}/${ri.repo}`);
  const res = await guardedFetch(`${ri.apiBaseUrl}/projects/${project}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "Optio" },
    redirect: "error",
  });
  const text = await res.text();
  if (!res.ok) throw GitLabApiError.fromResponse(res, text);
  return text ? JSON.parse(text) : null;
}

/**
 * Merge the base into the PR's branch (GitHub "Update branch"; GitLab
 * rebases). `expectedHeadSha` makes GitHub refuse if the head moved.
 */
export async function updatePrBranch(
  ri: RepoIdentifier,
  token: string,
  prNumber: number,
  expectedHeadSha?: string | null,
  fetchImpl?: Fetch,
): Promise<void> {
  if (ri.platform === "github") {
    try {
      await github(
        ri,
        token,
        `/pulls/${prNumber}/update-branch`,
        { method: "PUT", body: expectedHeadSha ? { expected_head_sha: expectedHeadSha } : {} },
        fetchImpl,
      );
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 422) {
        throw new PrQuickActionError(
          /conflict/i.test(err.body)
            ? "It has conflicts: they need resolving on the branch"
            : "GitHub couldn't update the branch (the head may have moved — refresh)",
          409,
        );
      }
      throw err;
    }
    return;
  }
  if (ri.platform === "gitlab") {
    await gitlab(ri, token, `/merge_requests/${prNumber}/rebase`, "PUT");
    return;
  }
  throw new PrQuickActionError("This platform can't update a branch from Optio");
}

const RERUNNABLE = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

/**
 * Re-run what failed on the PR's head commit: GitHub Actions runs (their
 * failed jobs only), GitLab's head pipeline. Returns how many were re-run.
 */
export async function rerunFailedChecks(
  ri: RepoIdentifier,
  token: string,
  prNumber: number,
  headSha: string,
  fetchImpl?: Fetch,
): Promise<number> {
  if (ri.platform === "github") {
    const data = await github(
      ri,
      token,
      `/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=50`,
      {},
      fetchImpl,
    );
    const runs: any[] = (data?.workflow_runs ?? []).filter((r: any) =>
      RERUNNABLE.has(r.conclusion),
    );
    if (runs.length === 0) {
      throw new PrQuickActionError(
        "No failed GitHub Actions runs on its head commit (other CI has to be re-run there)",
        404,
      );
    }
    for (const run of runs) {
      await github(
        ri,
        token,
        `/actions/runs/${run.id}/rerun-failed-jobs`,
        { method: "POST" },
        fetchImpl,
      );
    }
    return runs.length;
  }
  if (ri.platform === "gitlab") {
    const mr = await gitlab(ri, token, `/merge_requests/${prNumber}`);
    const id = mr?.head_pipeline?.id;
    if (typeof id !== "number") throw new PrQuickActionError("It has no pipeline to retry", 404);
    await gitlab(ri, token, `/pipelines/${id}/retry`, "POST");
    return 1;
  }
  throw new PrQuickActionError("This platform can't re-run checks from Optio");
}
