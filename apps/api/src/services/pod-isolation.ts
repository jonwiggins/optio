import { createHash } from "node:crypto";

/** Immutable execution boundary. A worktree is not a sandbox: processes,
 * credentials, home directories and caches in one pod are mutually readable.
 * Reviews have a separate boundary; interactive sessions get their own pod.
 * Old pods have no key and are never selected for new work.
 */
export interface PodIsolation {
  workspaceId?: string | null;
  ownerUserId?: string | null;
  isolationPurpose?: string;
  credentialProfile?: unknown;
  /**
   * The one run this pod is for (pod scope `run`): the run gets a pod of its
   * own, never shared with another run of the repo, and nothing of the pod
   * outlives it (no home or cache volume kept for reuse). Unset: the pod is
   * shared by every run inside the boundary above.
   */
  runId?: string | null;
}

export function podIsolationKey(scope: PodIsolation): string {
  const boundary = [
    "v1",
    scope.workspaceId ?? null,
    scope.ownerUserId ?? null,
    scope.isolationPurpose ?? "work",
    scope.credentialProfile ?? null,
  ];
  // Appended only when set: a shared pod's key is what it always was.
  if (scope.runId) boundary.push(`run:${scope.runId}`);
  return createHash("sha256").update(JSON.stringify(boundary)).digest("hex").slice(0, 32);
}

/** DNS-safe names with a collision-resistant digest of the complete resource. */
export function isolatedPodResource(
  prefix: string,
  resource: string,
  isolationKey: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([resource, isolationKey]))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

/** Configuration changes that remove access must not reuse files from a broader run. */
export function workCredentialProfile(work: {
  settings?: unknown;
  podSecrets?: unknown;
  agentOptions?: unknown;
}): unknown {
  return [work.settings ?? null, work.podSecrets ?? null, work.agentOptions ?? null];
}

/** What a repo's pods are shared across: every run of the repo, or nothing. */
export type PodScope = "repo" | "run";

const isPodScope = (v: unknown): v is PodScope => v === "repo" || v === "run";

/**
 * The pod scope a repo's runs use: the repo's own setting (`repos.pod_scope`),
 * else the deployment's (`OPTIO_POD_SCOPE`, Helm `agent.podScope`), else
 * `repo` — one long-lived pod per repo and execution boundary, a worktree per
 * run. `run` gives every task and PR review a pod of its own.
 */
export function resolvePodScope(repoSetting?: string | null): PodScope {
  if (isPodScope(repoSetting)) return repoSetting;
  const deployment = process.env.OPTIO_POD_SCOPE?.trim().toLowerCase();
  return isPodScope(deployment) ? deployment : "repo";
}

/** The `runId` to isolate a run's pod by, or undefined when the repo's pods are shared. */
export function podRunId(
  repoSetting: string | null | undefined,
  runId: string,
): string | undefined {
  return resolvePodScope(repoSetting) === "run" ? runId : undefined;
}
