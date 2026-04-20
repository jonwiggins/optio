export const DEFAULT_BRANCH = "main";
export const DEFAULT_MAX_RETRIES = 3;
export const TASK_BRANCH_PREFIX = "optio/task-";
export const DEFAULT_AGENT_IMAGE = "optio-agent:latest";
export const DEFAULT_TICKET_LABEL = "optio";
export const DEFAULT_MAX_TURNS_CODING = 250;
export const DEFAULT_MAX_TURNS_REVIEW = 30;
export const DEFAULT_MAX_TICKET_PAGES = 20;

// ── Shared directory (cache) defaults ─────────────────────────────────────────
export const DEFAULT_CACHE_SIZE_GI = 10;
export const MAX_CACHE_SIZE_PER_DIR_GI = 100;
export const MAX_CACHE_SIZE_TOTAL_GI = 200;

/**
 * Default threshold (in ms) before a running task is flagged as "stalled".
 * Override per-repo via `repos.stallThresholdMs` or globally via
 * `OPTIO_STALL_THRESHOLD_MS` env var.
 */
export const DEFAULT_STALL_THRESHOLD_MS = 300_000; // 5 minutes

/**
 * Max length for K8s resource names.
 */
const K8S_NAME_MAX = 63;

/**
 * Generate a human-readable pod name from a repo URL.
 *
 * Format: `optio-repo-<owner>-<repo>-<hash>` where hash is a 4-char hex suffix
 * for uniqueness. Names are valid K8s resource names (lowercase, alphanumeric +
 * hyphens, max 63 chars). Long owner/repo names are truncated gracefully.
 */
/**
 * Generate a human-readable pod name for a pooled workflow pod.
 *
 * Format: `optio-wf-<workflowId-prefix>-<instanceIndex>-<hash>` where hash is a
 * 4-char hex suffix and instanceIndex is the pool slot. Names are valid K8s
 * resource names. The random suffix differentiates replacement pods created
 * after the previous one errored or was removed.
 */
export function generateWorkflowPodName(workflowId: string, instanceIndex = 0): string {
  const prefix = "optio-wf-";
  const idxSuffix = `-${instanceIndex}`;
  const hashSuffix = "-xxxx"; // placeholder — 5 chars
  const maxBodyLen = K8S_NAME_MAX - prefix.length - idxSuffix.length - hashSuffix.length;

  const sanitized = workflowId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxBodyLen);

  const hash = Math.random().toString(16).slice(2, 6);
  return `${prefix}${sanitized}${idxSuffix}-${hash}`;
}

export function generateRepoPodName(repoUrl: string): string {
  // Extract owner/repo from URL patterns like:
  //   https://github.com/owner/repo.git
  //   git@github.com:owner/repo.git
  const match = repoUrl.match(/[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  const owner = match?.[1] ?? "unknown";
  const repo = match?.[2] ?? "unknown";

  // Sanitize: lowercase, replace non-alphanumeric with hyphens, collapse multiples
  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

  const prefix = "optio-repo-";
  // 4-char random hex suffix + 1 hyphen separator
  const suffixLen = 5;
  const maxBodyLen = K8S_NAME_MAX - prefix.length - suffixLen;

  let ownerClean = sanitize(owner);
  let repoClean = sanitize(repo);

  // Ensure we fit within the max body length (owner + hyphen + repo)
  const totalLen = ownerClean.length + 1 + repoClean.length;
  if (totalLen > maxBodyLen) {
    // Split budget: give repo at least half
    const repoBudget = Math.floor(maxBodyLen / 2);
    const ownerBudget = maxBodyLen - repoBudget - 1; // -1 for separator
    ownerClean = ownerClean.slice(0, ownerBudget).replace(/-$/, "");
    repoClean = repoClean.slice(0, repoBudget).replace(/-$/, "");
  }

  const hash = Math.random().toString(16).slice(2, 6);
  return `${prefix}${ownerClean}-${repoClean}-${hash}`;
}

/**
 * Generate a deterministic StatefulSet name for a repo URL.
 *
 * Format: `optio-sts-<owner>-<repo>` — NO random suffix so that multiple
 * API replicas produce the same name for the same repo. Pod names within
 * the StatefulSet are `<sts-name>-<ordinal>`.
 */
export function generateStatefulSetName(repoUrl: string): string {
  const match = repoUrl.match(/[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  const owner = match?.[1] ?? "unknown";
  const repo = match?.[2] ?? "unknown";

  const sanitize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

  const prefix = "optio-sts-";
  const maxBodyLen = K8S_NAME_MAX - prefix.length;

  let ownerClean = sanitize(owner);
  let repoClean = sanitize(repo);

  const totalLen = ownerClean.length + 1 + repoClean.length;
  if (totalLen > maxBodyLen) {
    const repoBudget = Math.floor(maxBodyLen / 2);
    const ownerBudget = maxBodyLen - repoBudget - 1;
    ownerClean = ownerClean.slice(0, ownerBudget).replace(/-$/, "");
    repoClean = repoClean.slice(0, repoBudget).replace(/-$/, "");
  }

  return `${prefix}${ownerClean}-${repoClean}`;
}

/**
 * Generate a deterministic K8s Job name for a pooled workflow pod.
 *
 * Format: `optio-wfj-<workflowId>-<instanceIndex>` — deterministic so that
 * multiple API replicas produce the same name for the same pool slot. The
 * Job hosts one long-lived pod that handles multiple concurrent runs, up to
 * the workflow's maxAgentsPerPod.
 */
export function generateWorkflowJobName(workflowId: string, instanceIndex = 0): string {
  const prefix = "optio-wfj-";
  const idxSuffix = `-${instanceIndex}`;
  const sanitized = workflowId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, K8S_NAME_MAX - prefix.length - idxSuffix.length);

  return `${prefix}${sanitized}${idxSuffix}`;
}
