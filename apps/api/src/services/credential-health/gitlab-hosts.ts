/**
 * Credential health (docs/credential-health.md): which GitLab hosts a token
 * is checked against. Pure; `inventory.ts` gathers the inputs.
 *
 * A token goes only to a host a deployment admin named: the setup wizard's
 * `GITLAB_HOST` (a deployment secret) and the chart's `gitlab.hosts`
 * (`GITLAB_HOSTS`), in that order; the first that accepts it is its own. A
 * repo's host is never enough: any workspace admin adds repos, on any host,
 * and the check runs for every token in the deployment without anyone
 * starting work. (A `GITLAB_TOKEN_<HOST>` goes only to the host it names;
 * `inventory.ts` sorts that out.)
 *
 * `gitlab.com` is upstream's built-in GitLab, asked only when no GitLab is
 * named, and never where agents reach their models through a gateway only
 * (`OPTIO_MODEL_ACCESS=gateway`), whose network keeps to the hosts its admin
 * named (`allowGitLabCom: false`).
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
  /** Whether gitlab.com may be asked (not with `OPTIO_MODEL_ACCESS=gateway`). */
  allowGitLabCom: boolean;
}

/**
 * The hosts to try for one token, in order (the first that accepts it is
 * its own). Empty when no host may be asked: the check says so.
 */
export function gitlabHostsFor(input: GitLabHostsInput): string[] {
  const named = namedGitLabHosts(input.named, input.allowGitLabCom);
  if (named.length) return named;
  return input.allowGitLabCom ? [PUBLIC_GITLAB] : [];
}
