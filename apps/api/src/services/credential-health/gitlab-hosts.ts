/**
 * Credential health (docs/credential-health.md): which GitLab hosts a token
 * is checked against. Pure; `inventory.ts` gathers the inputs.
 *
 * A token goes only to a host a deployment admin named: the setup wizard's
 * `GITLAB_HOST` (a deployment secret) and the chart's `gitlab.hosts`
 * (`GITLAB_HOSTS`). A repo's host is never enough on its own: any workspace
 * admin adds repos, on any host, and the check runs for every token in the
 * deployment without anyone starting work. Of the named hosts, a token goes
 * to those its owner's work uses (the repos of the person's workspaces, the
 * team's workspace, every workspace for the organization's); to the other
 * named ones only when the owner has no GitLab repo at all; and to none when
 * the owner's repos are all on hosts nobody named (Optio doesn't guess).
 *
 * `gitlab.com` is upstream's built-in GitLab, asked for a token whose owner
 * has repos there, or when no GitLab is named and the owner has no repo
 * anywhere else — but never where agents reach their models through a
 * gateway only (`OPTIO_MODEL_ACCESS=gateway`), whose network keeps to the
 * hosts its admin named (`allowGitLabCom: false`).
 */

export const PUBLIC_GITLAB = "gitlab.com";

/** `https://GitLab.example.test:8443/` → `gitlab.example.test:8443`. */
export function normalizeGitLabHost(h: string | null | undefined): string {
  return (h ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

/** The host name alone: a repo URL's host has no port, a named host may. */
const bare = (h: string) => h.replace(/:\d+$/, "");

function unique(hosts: Iterable<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const h of hosts) {
    const v = normalizeGitLabHost(h);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The named hosts, in order, without `gitlab.com` unless `allowGitLabCom`. */
export function namedGitLabHosts(
  named: Iterable<string | null | undefined>,
  allowGitLabCom: boolean,
): string[] {
  return unique(named).filter((h) => allowGitLabCom || bare(h) !== PUBLIC_GITLAB);
}

export interface GitLabHostsInput {
  /** What a deployment admin named: GITLAB_HOST, then GITLAB_HOSTS. */
  named: string[];
  /** The hosts of the GitLab repos the token's owner works on. */
  ownerRepoHosts: Iterable<string | null | undefined>;
  /** Whether gitlab.com may be asked (not with `OPTIO_MODEL_ACCESS=gateway`). */
  allowGitLabCom: boolean;
}

/**
 * The hosts to try for one token, in order (the first that accepts it is
 * its own). Empty when no host may be asked: the check says so.
 */
export function gitlabHostsFor(input: GitLabHostsInput): string[] {
  const named = namedGitLabHosts(input.named, input.allowGitLabCom);
  const own = new Set(unique(input.ownerRepoHosts).map(bare));
  const owned = named.filter((h) => own.has(bare(h)));
  if (
    input.allowGitLabCom &&
    own.has(PUBLIC_GITLAB) &&
    !owned.some((h) => bare(h) === PUBLIC_GITLAB)
  ) {
    owned.push(PUBLIC_GITLAB);
  }
  if (owned.length) return owned;
  // The owner's work is on hosts nobody named: asking another would only guess.
  if (own.size) return [];
  if (named.length) return named;
  return input.allowGitLabCom ? [PUBLIC_GITLAB] : [];
}
