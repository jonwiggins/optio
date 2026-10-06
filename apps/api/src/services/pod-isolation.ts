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
}

export function podIsolationKey(scope: PodIsolation): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "v1",
        scope.workspaceId ?? null,
        scope.ownerUserId ?? null,
        scope.isolationPurpose ?? "work",
        scope.credentialProfile ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
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
