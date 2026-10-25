import type { RepoIdentifier } from "@optio/shared";
import {
  CI_LOG_TAIL_LINES,
  tailOfLog,
  type FailedJobLog,
  type FailedJobs,
} from "./gitlab-ci-logs.js";

/**
 * The failed GitHub Actions jobs of a pull request's head commit, with the
 * end of each job's log — GitHub's counterpart of gitlab-ci-logs.ts, for the
 * prompt that resumes an agent on failing checks (resume-facts.ts, when
 * `OPTIO_CI_FAILURE_LOGS=true`).
 *
 * The API reads them once: the workflow runs of the head commit
 * (`/actions/runs?head_sha=`) that failed, their failed jobs
 * (`/actions/runs/:id/jobs?filter=latest`), and each job's log
 * (`/actions/jobs/:id/logs`, a redirect to a short-lived download URL that
 * is fetched without the token), of which the last lines are kept, masked
 * as GitLab's are. Every read is bounded in time and size; a failure is the
 * caller's to swallow (the prompt then keeps upstream's wording).
 */

const MAX_JOBS = 5;
const MAX_RUNS = 5;
/** Only the end of a log is kept; this much of it is read at most. */
const LOG_TAIL_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

interface WorkflowRun {
  id: number;
  name?: string;
  conclusion?: string | null;
  html_url?: string;
  workflow_id?: number;
  run_attempt?: number;
  created_at?: string;
}

interface Job {
  id: number;
  name?: string;
  conclusion?: string | null;
  html_url?: string;
}

/** A GitHub job log as a person reads it: no timestamps, no `##[group]` markers. */
export function cleanGitHubLog(raw: string): string {
  return raw
    .split("\n")
    .map((line) =>
      line
        .replace(/^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, "")
        .replace(/^##\[(?:group|endgroup|command|debug)\]/, "")
        .replace(/^##\[(error|warning|notice)\]/, (_m, kind: string) => `${kind}: `),
    )
    .join("\n");
}

/**
 * The failed jobs of the head commit's failed workflow runs (the newest run
 * of each workflow), with their log tails; null when no run failed.
 */
export async function fetchFailedGitHubJobLogs(
  ri: RepoIdentifier,
  token: string,
  sha: string,
  opts: { maxJobs?: number; tailLines?: number; knownSecrets?: string[] } = {},
): Promise<FailedJobs | null> {
  const repo = `${ri.apiBaseUrl}/repos/${ri.owner}/${ri.repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Optio",
  };
  const getJson = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${repo}${path}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GitHub API error ${res.status} on ${path.split("?")[0]}`);
    return (await res.json()) as T;
  };

  const { workflow_runs: runs = [] } = await getJson<{ workflow_runs?: WorkflowRun[] }>(
    `/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`,
  );
  // The newest run of each workflow is what the checks show.
  const newest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const key = String(run.workflow_id ?? run.name ?? run.id);
    const seen = newest.get(key);
    if (!seen || (run.created_at ?? "") > (seen.created_at ?? "")) newest.set(key, run);
  }
  const failedRuns = [...newest.values()]
    .filter((r) => FAILED.has(r.conclusion ?? ""))
    .slice(0, MAX_RUNS);
  if (failedRuns.length === 0) return null;

  const failed: Array<{ job: Job; run: WorkflowRun }> = [];
  for (const run of failedRuns) {
    const { jobs = [] } = await getJson<{ jobs?: Job[] }>(
      `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    );
    for (const job of jobs) if (FAILED.has(job.conclusion ?? "")) failed.push({ job, run });
  }
  if (failed.length === 0) return null;

  const maxJobs = opts.maxJobs ?? MAX_JOBS;
  const tailLines = opts.tailLines ?? CI_LOG_TAIL_LINES;
  const secrets = [token, ...(opts.knownSecrets ?? [])];
  const jobs: FailedJobLog[] = [];
  for (const { job, run } of failed.slice(0, maxJobs)) {
    let tail = "";
    try {
      const raw = await readJobLog(`${repo}/actions/jobs/${job.id}/logs`, headers);
      if (raw !== null) tail = tailOfLog(cleanGitHubLog(raw), tailLines, secrets);
    } catch {
      // The job's name and workflow still help; its log stays out.
    }
    jobs.push({
      id: job.id,
      name: job.name ?? `job ${job.id}`,
      stage: run.name ?? "",
      ...(job.html_url ? { webUrl: job.html_url } : {}),
      tail,
    });
  }
  const first = failedRuns[0];
  return {
    pipelineId: first.id,
    ...(first.html_url ? { pipelineUrl: first.html_url } : {}),
    jobs,
    more: failed
      .slice(maxJobs)
      .map(({ job, run }) => ({ name: job.name ?? `job ${job.id}`, stage: run.name ?? "" })),
  };
}

/**
 * A job's log. GitHub answers with a redirect to a download URL on another
 * host; that one is fetched without the token. Null when there is no log.
 */
async function readJobLog(url: string, headers: Record<string, string>): Promise<string | null> {
  const res = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) return null;
    const download = await fetch(location, {
      headers: { "User-Agent": "Optio" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return download.ok ? readTail(download, LOG_TAIL_BYTES) : null;
  }
  return res.ok ? readTail(res, LOG_TAIL_BYTES) : null;
}

/** The last `maxBytes` of a response body, without holding the whole of it. */
async function readTail(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(-maxBytes);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let held = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    held += value.byteLength;
    while (chunks.length > 1 && held - chunks[0].byteLength >= maxBytes) {
      held -= chunks.shift()!.byteLength;
    }
  }
  const all = Buffer.concat(chunks);
  return all.subarray(Math.max(0, all.byteLength - maxBytes)).toString("utf8");
}
