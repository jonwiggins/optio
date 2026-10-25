import { gitLabFetch } from "../gitlab-instance-runtime.js";
import type { RepoIdentifier } from "@optio/shared";

/**
 * The failed jobs of a merge request's pipeline, with the end of each job's
 * log, for the prompt that resumes an agent on a failed pipeline
 * (reconcile-executor.ts, through resume-facts.ts).
 *
 * Upstream's prompt only says "CI checks are failing … investigate", which
 * costs a smaller in-house model on the gateway many turns (finding the
 * pipeline, the job, then reading a long log through `glab`). Here the API
 * reads them once: the newest pipeline of the MR's head commit
 * (`/pipelines?sha=`, the one the watcher judged), its failed jobs
 * (`/pipelines/:id/jobs?scope[]=failed`), and each job's log
 * (`/jobs/:id/trace`), of which the last lines are kept — that's where a
 * job says why it failed.
 *
 * Logs can carry secrets the job printed: GitLab masks its own masked
 * variables, and `maskSecrets` masks the shapes of common tokens, passwords
 * and keys on top, plus any value the caller names (the token used here).
 *
 * The API reaches GitLab with the chart's CA bundle (`NODE_EXTRA_CA_CERTS`),
 * as gitlab.ts does. Every read is bounded in time and size; a failure is
 * the caller's to swallow (the prompt then falls back to the old wording).
 */

export interface FailedJobLog {
  id: number;
  name: string;
  stage: string;
  /** The job's page on GitLab, when given. */
  webUrl?: string;
  /** The last lines of the log, masked; empty when it couldn't be read. */
  tail: string;
}

export interface FailedJobs {
  pipelineId: number;
  pipelineUrl?: string;
  /** The jobs whose logs are included (at most `maxJobs`). */
  jobs: FailedJobLog[];
  /** Further failed jobs, by name only. */
  more: Array<{ name: string; stage: string }>;
}

export const CI_LOG_TAIL_LINES = 150;
const MAX_JOBS = 5;
const MAX_LINE_CHARS = 500;
const MAX_JOB_CHARS = 10_000;
/** Only the end of a log is kept; this much of it is read at most. */
const TRACE_TAIL_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;

interface GitLabJob {
  id: number;
  name?: string;
  stage?: string;
  status?: string;
  allow_failure?: boolean;
  web_url?: string;
}

/**
 * The failed jobs of the pipeline GitLab shows on the MR (`mrIid`'s
 * `head_pipeline`, which may be a merged-results pipeline on another SHA),
 * else of the newest pipeline on `sha`, with their log tails; null when
 * there is none.
 */
export async function fetchFailedJobLogs(
  ri: RepoIdentifier,
  token: string,
  sha: string,
  opts: { maxJobs?: number; tailLines?: number; knownSecrets?: string[]; mrIid?: number } = {},
): Promise<FailedJobs | null> {
  const project = `${ri.apiBaseUrl}/projects/${encodeURIComponent(`${ri.owner}/${ri.repo}`)}`;
  const headers = { Authorization: `Bearer ${token}`, "User-Agent": "Optio" };
  const getJson = async <T>(path: string): Promise<T> => {
    const res = await gitLabFetch(`${project}${path}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitLab API error ${res.status} on ${path.split("?")[0]}`);
    return (await res.json()) as T;
  };

  let pipeline: { id: number; web_url?: string } | undefined;
  if (opts.mrIid) {
    const mr = await getJson<{ sha?: string; head_pipeline?: { id?: number; web_url?: string } }>(
      `/merge_requests/${opts.mrIid}`,
    ).catch(() => null);
    const hp = mr?.head_pipeline;
    if (mr?.sha === sha && typeof hp?.id === "number")
      pipeline = { id: hp.id, web_url: hp.web_url };
  }
  if (!pipeline) {
    const pipelines = await getJson<Array<{ id: number; web_url?: string }>>(
      `/pipelines?sha=${encodeURIComponent(sha)}&per_page=1`,
    );
    pipeline = pipelines[0];
  }
  if (!pipeline) return null;

  const failed = await getJson<GitLabJob[]>(
    `/pipelines/${pipeline.id}/jobs?scope[]=failed&per_page=100`,
  );
  // A job allowed to fail doesn't fail the pipeline: the others first.
  const blocking = failed.filter((j) => !j.allow_failure);
  const ordered = blocking.length > 0 ? blocking : failed;
  if (ordered.length === 0) return null;

  const maxJobs = opts.maxJobs ?? MAX_JOBS;
  const tailLines = opts.tailLines ?? CI_LOG_TAIL_LINES;
  const secrets = [token, ...(opts.knownSecrets ?? [])];
  const jobs: FailedJobLog[] = [];
  for (const job of ordered.slice(0, maxJobs)) {
    let tail = "";
    try {
      const res = await gitLabFetch(`${project}/jobs/${job.id}/trace`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) tail = tailOfLog(await readTail(res, TRACE_TAIL_BYTES), tailLines, secrets);
    } catch {
      // The job's name and stage still help; its log stays out.
    }
    jobs.push({
      id: job.id,
      name: job.name ?? `job ${job.id}`,
      stage: job.stage ?? "",
      ...(job.web_url ? { webUrl: job.web_url } : {}),
      tail,
    });
  }
  return {
    pipelineId: pipeline.id,
    ...(pipeline.web_url ? { pipelineUrl: pipeline.web_url } : {}),
    jobs,
    more: ordered
      .slice(maxJobs)
      .map((j) => ({ name: j.name ?? `job ${j.id}`, stage: j.stage ?? "" })),
  };
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
  // A cut in the middle of a character decodes to U+FFFD on the first line,
  // which the line cut below drops anyway.
  return all.subarray(Math.max(0, all.byteLength - maxBytes)).toString("utf8");
}

/**
 * A job log as a person reads it: GitLab's section markers and ANSI colours
 * removed, a progress line reduced to what it last showed, then the last
 * `lines` lines (each at most 500 characters), masked.
 */
export function tailOfLog(raw: string, lines: number, knownSecrets: string[] = []): string {
  const clean = raw

    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]\r\n]*\])?\r?/g, "")
    .split("\n")
    .map((line) => {
      const parts = line.replace(/\r+$/, "").split("\r");
      return parts[parts.length - 1];
    });
  while (clean.length > 0 && clean[clean.length - 1].trim() === "") clean.pop();
  const kept = clean
    .slice(-lines)
    .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l));
  let text = maskSecrets(kept.join("\n"), knownSecrets);
  if (text.length > MAX_JOB_CHARS) text = `…${text.slice(-MAX_JOB_CHARS)}`;
  return text;
}

const MASK = "[MASKED]";

/** Shapes of secrets a job may print, masked wherever they appear. */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[MASKED PRIVATE KEY]",
  ],
  // GitLab tokens (personal, deploy, runner, trigger, CI job, OAuth, …).
  [
    /\b(?:glpat|gloas|gldt|glrtr?|glcbt|glptt|glft|glimt|glagent|glsoat|glffct|glwt)-[A-Za-z0-9_-]{16,}/g,
    MASK,
  ],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // user:password@ in a URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
  [/(\bauthorization\s*[:=]\s*(?:bearer|basic|token)?\s*)[^\s"']+/gi, `$1${MASK}`],
  [/((?:private-token|x-api-key|api-key)\s*[:=]\s*)[^\s"']+/gi, `$1${MASK}`],
  // NAME=value / name: value where the name says it's a secret.
  [
    /(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"\n]+"|'[^'\n]+'|[^\s,;"']{4,})/gi,
    `$1${MASK}`,
  ],
];

/** `text` with every secret shape and every known value (8+ characters) masked. */
export function maskSecrets(text: string, knownSecrets: string[] = []): string {
  let out = text;
  for (const value of knownSecrets) {
    if (value && value.length >= 8) out = out.split(value).join(MASK);
  }
  for (const [re, by] of SECRET_SHAPES) out = out.replace(re, by);
  return out;
}
