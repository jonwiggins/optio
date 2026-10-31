/**
 * GitHub Issues in the ticket round trip (docs/ticket-round-trip.md, the
 * GitHub section), over GitHub's REST API (`https://api.github.com`, API
 * version 2022-11-28) with the provider's token:
 *
 *   comments     POST /repos/{owner}/{repo}/issues/{n}/comments;
 *                GET  …/comments (ascending by id, 100 a page: the last pages)
 *   the link     one comment by Optio, edited in place
 *                (PATCH /repos/{owner}/{repo}/issues/comments/{id}); the pull
 *                request itself links the issue through `Closes #n` in its body
 *   statuses     Open / Closed (PATCH …/issues/{n} `state`, `state_reason`) and
 *                the repository's labels (GET …/labels; POST …/issues/{n}/labels;
 *                DELETE …/issues/{n}/labels/{name}) — moving to a label takes
 *                the other steps' labels off
 *   who am I     GET /user
 */
import type { TicketProviderConfig } from "@optio/shared";
import {
  atMentions,
  isNotFound,
  linkCommentBody,
  markdownCommentBody,
  sameName,
  serviceCall,
  TicketServiceError,
  type TicketCommentRecord,
  type TicketRoundTrip,
} from "./round-trip.js";

const API = "https://api.github.com";
const SERVICE = "GitHub";
const STATES = ["Open", "Closed"] as const;

interface GitHubRoundTripConfig {
  token: string;
  owner: string;
  repo: string;
}

function asConfig(config: TicketProviderConfig): GitHubRoundTripConfig {
  const c = config as Partial<GitHubRoundTripConfig>;
  if (!c.token || !c.owner || !c.repo) {
    throw new Error("GitHub provider requires token, owner, and repo in config");
  }
  return c as GitHubRoundTripConfig;
}

function call<T>(
  config: TicketProviderConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const c = asConfig(config);
  return serviceCall<T>(SERVICE, `${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${c.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Optio",
    },
  });
}

function repoPath(config: TicketProviderConfig): string {
  const c = asConfig(config);
  return `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
}

function issueNumber(ticketId: string): string {
  if (!/^\d+$/.test(ticketId)) throw new Error(`Not a GitHub issue number: ${ticketId}`);
  return ticketId;
}

/** The page number `rel="last"` names in a Link header, or 1. */
function lastPage(link: string | null): number {
  const m = link?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return m ? Number(m[1]) : 1;
}

interface GitHubComment {
  id: number;
  body?: string | null;
  created_at: string;
  user?: { id: number; login: string; type?: string } | null;
  performed_via_github_app?: unknown;
  /** OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER, NONE, … */
  author_association?: string;
}

/** Who may push to the repository: anyone else's comment never steers the work. */
const STEERING_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface GitHubIssue {
  state: string;
  labels: Array<string | { name?: string }>;
}

const labelNames = (issue: GitHubIssue) =>
  issue.labels.map((l) => (typeof l === "string" ? l : l.name)).filter((n): n is string => !!n);

const stateName = (state: string) => (state === "closed" ? "Closed" : "Open");

async function repoLabels(config: TicketProviderConfig): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await call<Array<{ name: string }>>(
      config,
      `${repoPath(config)}/labels?per_page=100&page=${page}`,
    );
    names.push(...(res.body ?? []).map((l) => l.name));
    if (lastPage(res.headers.get("link")) <= page) break;
  }
  return names;
}

async function getIssue(ticketId: string, config: TicketProviderConfig) {
  return (await call<GitHubIssue>(config, `${repoPath(config)}/issues/${issueNumber(ticketId)}`))
    .body;
}

export const githubRoundTrip: TicketRoundTrip = {
  source: "github",
  capabilities: { links: true, statuses: true },

  normalizeTicketId: (input) => {
    const s = input.trim();
    const m = s.match(/^#?(\d+)$/) ?? s.match(/\/issues\/(\d+)(?:[/?#]|$)/);
    return m ? m[1] : null;
  },

  async whoAmI(config) {
    try {
      const me = (await call<{ id: number; login: string; name?: string | null }>(config, "/user"))
        .body;
      return { accountId: String(me.id), name: me.login, displayName: me.name || me.login };
    } catch (err) {
      if (!(err instanceof TicketServiceError) || err.status !== 403) throw err;
      // Installation tokens have no /user. Verify that this is one rather
      // than proceeding after an identity failure. Their comments always
      // have a Bot author, excluded by listComments' bot flag (plus saved ids).
      await call(config, "/installation/repositories?per_page=1");
      return { displayName: "GitHub App installation" };
    }
  },

  async listComments(ticketId, config, max = 50) {
    const base = `${repoPath(config)}/issues/${issueNumber(ticketId)}/comments?per_page=100`;
    const first = await call<GitHubComment[]>(config, `${base}&page=1`);
    let rows = first.body ?? [];
    const last = lastPage(first.headers.get("link"));
    // Ascending by id: the newest are on the last pages.
    for (let page = Math.max(2, last - 1); page <= last; page++) {
      rows = rows.concat((await call<GitHubComment[]>(config, `${base}&page=${page}`)).body ?? []);
    }
    const seen = new Set<number>();
    return rows
      .filter((c) => !seen.has(c.id) && seen.add(c.id))
      .sort((a, b) => a.id - b.id)
      .slice(-max)
      .map((c): TicketCommentRecord => ({
        id: String(c.id),
        author: {
          accountId: c.user ? String(c.user.id) : null,
          name: c.user?.login ?? null,
          displayName: c.user?.login ?? null,
        },
        body: c.body ?? "",
        created: c.created_at,
        bot: c.user?.type === "Bot" || !!c.performed_via_github_app,
        trusted: STEERING_ASSOCIATIONS.has(c.author_association ?? ""),
      }));
  },

  async postComment(ticketId, parts, config) {
    const res = await call<{ id: number }>(
      config,
      `${repoPath(config)}/issues/${issueNumber(ticketId)}/comments`,
      { method: "POST", body: { body: markdownCommentBody(parts) } },
    );
    return { id: res.body?.id != null ? String(res.body.id) : null };
  },

  async upsertLink(ticketId, link, config) {
    const body = linkCommentBody(link);
    if (link.previousId) {
      try {
        await call(config, `${repoPath(config)}/issues/comments/${link.previousId}`, {
          method: "PATCH",
          body: { body },
        });
        return { id: link.previousId };
      } catch (err) {
        // Someone deleted it: a new one takes its place.
        if (!isNotFound(err)) throw err;
      }
    }
    const res = await call<{ id: number }>(
      config,
      `${repoPath(config)}/issues/${issueNumber(ticketId)}/comments`,
      { method: "POST", body: { body } },
    );
    return { id: res.body?.id != null ? String(res.body.id) : null };
  },

  async statuses(config) {
    const labels = await repoLabels(config);
    return {
      statuses: [
        ...STATES.map((name) => ({ name, category: "State" })),
        ...labels.map((name) => ({ name, category: "Label" })),
      ],
      scope: "repository",
    };
  },

  async issueStatus(ticketId, config) {
    const [issue, labels] = await Promise.all([getIssue(ticketId, config), repoLabels(config)]);
    const current = [stateName(issue.state), ...labelNames(issue)];
    const available = [...STATES, ...labels].filter((n) => !current.some((c) => sameName(c, n)));
    return { status: stateName(issue.state), current, available };
  },

  async moveToStatus(ticketId, status, config, opts = {}) {
    const n = issueNumber(ticketId);
    const issue = await getIssue(ticketId, config);
    const from = stateName(issue.state);
    const onIssue = labelNames(issue);
    // The other steps' labels that are on the issue now (not states, not the target).
    const off = onIssue.filter(
      (l) =>
        !sameName(l, status) &&
        (opts.others ?? []).some((o) => sameName(o, l) && !STATES.some((s) => sameName(s, o))),
    );
    const state = STATES.find((s) => sameName(s, status));
    if (state) {
      const there = sameName(from, state);
      if (!there) {
        await call(config, `${repoPath(config)}/issues/${n}`, {
          method: "PATCH",
          body:
            state === "Closed"
              ? { state: "closed", state_reason: "completed" }
              : { state: "open", state_reason: "reopened" },
        });
      }
      await removeLabels(config, n, off);
      return there && !off.length
        ? { moved: false, from, reason: "already" }
        : { moved: true, from };
    }
    const labels = await repoLabels(config);
    const label = labels.find((l) => sameName(l, status));
    if (!label)
      return { moved: false, from, reason: "unreachable", available: [...STATES, ...labels] };
    const has = onIssue.some((l) => sameName(l, label));
    if (has && !off.length) return { moved: false, from, reason: "already" };
    if (!has) {
      await call(config, `${repoPath(config)}/issues/${n}/labels`, {
        method: "POST",
        body: { labels: [label] },
      });
    }
    await removeLabels(config, n, off);
    return { moved: true, from };
  },

  mentionsAccount: (body, account) => atMentions(body, account?.name),
};

async function removeLabels(config: TicketProviderConfig, n: string, names: string[]) {
  for (const name of names) {
    try {
      await call(config, `${repoPath(config)}/issues/${n}/labels/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
    } catch (err) {
      if (!isNotFound(err)) throw err; // someone took it off first
    }
  }
}
