/**
 * Picking the machine an offline host most likely *is*. A computer whose
 * hostname changed under a daemon that didn't send its id yet shows up
 * twice: the old row (offline for good) and a new one. Same platform and
 * architecture plus shared folders make a strong guess; the person still
 * confirms the merge.
 */

export interface MergeableHost {
  id: string;
  name: string;
  state: string;
  platform: string;
  arch: string | null;
  lastSeenAt: string | null;
  dirs: Array<{ path: string }>;
}

/** Hosts `source` could be merged into, likeliest first. */
export function mergeTargets<H extends MergeableHost>(source: MergeableHost, hosts: H[]): H[] {
  const score = (h: MergeableHost) => {
    const shared = h.dirs.filter((d) => source.dirs.some((s) => s.path === d.path)).length;
    const sameMachineKind = h.platform === source.platform && h.arch === source.arch;
    return (sameMachineKind ? 1000 : 0) + shared * 10 + (h.state === "online" ? 1 : 0);
  };
  const seen = (h: MergeableHost) => (h.lastSeenAt ? Date.parse(h.lastSeenAt) : 0);
  return hosts
    .filter((h) => h.id !== source.id)
    .sort((a, b) => score(b) - score(a) || seen(b) - seen(a));
}

/**
 * The host `source` is very likely the same computer as, or null: same
 * platform and architecture, at least one shared folder, and only one such
 * host.
 */
export function likelySameComputer<H extends MergeableHost>(
  source: MergeableHost,
  hosts: H[],
): H | null {
  const matches = hosts.filter(
    (h) =>
      h.id !== source.id &&
      h.platform === source.platform &&
      h.arch === source.arch &&
      h.dirs.some((d) => source.dirs.some((s) => s.path === d.path)),
  );
  return matches.length === 1 ? matches[0]! : null;
}
