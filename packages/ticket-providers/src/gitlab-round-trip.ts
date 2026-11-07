/**
 * GitLab Issues in the ticket round trip (docs/ticket-round-trip.md, the
 * GitLab section), over GitLab's REST API v4 at the provider's host
 * (`https://<host>/api/v4`, Bearer auth, the outbound URL guard first):
 *
 *   comments     POST /projects/:id/issues/:iid/notes;
 *                GET  …/notes?sort=desc&order_by=created_at (system notes left out)
 *   the link     one note by Optio, edited in place (PUT …/notes/:note_id); the
 *                merge request relates itself to the issue through `Closes #iid`
 *   statuses     Open / Closed (PUT /projects/:id/issues/:iid `state_event`) and
 *                the project's labels (GET /projects/:id/labels; `add_labels`,
 *                `remove_labels`) — moving to a label takes the other steps' off
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
  type TicketCommentRecord,
  type TicketRoundTrip,
} from "./round-trip.js";

const SERVICE = "GitLab";
/** GitLab's access level for Developer: may push to the project. */
const DEVELOPER_ACCESS = 30;
const STATES = ["Open", "Closed"] as const;

interface GitLabRoundTripConfig {
  token: string;
  projectPath?: string;
  groupPath?: string;
  host?: string;
}

function asConfig(config: TicketProviderConfig): GitLabRoundTripConfig {
  const c = config as Partial<GitLabRoundTripConfig>;
  if (!c.token || !(c.projectPath || c.groupPath)) {
    throw new Error("GitLab provider requires token and projectPath or groupPath in config");
  }
  return c as GitLabRoundTripConfig;
}

function call<T>(
  config: TicketProviderConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const c = asConfig(config);
  return serviceCall<T>(
    SERVICE,
    `${gitLabBase(c)}/api/v4${path}`,
    { ...init, headers: { Authorization: `Bearer ${c.token}` } },
    { guard: true },
  );
}

function issuePath(config: TicketProviderConfig, ticketId: string): string {
  if (!/^\d+$/.test(ticketId)) throw new Error(`Not a GitLab issue number: ${ticketId}`);
  const project = asConfig(config).projectPath;
  if (!project) throw new Error("GitLab provider needs the ticket's projectPath for this call");
  return `/projects/${encodeURIComponent(project)}/issues/${ticketId}`;
}

function gitLabBase(config: { host?: string }): string {
  const host = (config.host || "gitlab.com")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  const url = new URL(`https://${host}`);
  if (url.username || url.password || url.search || url.hash)
    throw new Error("Invalid GitLab host");
  return url.href.replace(/\/+$/, "");
}

/** A group's ticket names its project in its URL; credentials stay at the configured base. */
export function gitLabRoundTripConfig(
  config: TicketProviderConfig,
  ticketUrl?: string | null,
): TicketProviderConfig {
  const c = asConfig(config);
  if (c.projectPath) return config;
  if (!ticketUrl) throw new Error("GitLab group ticket needs its saved issue URL");
  const base = `${gitLabBase(c)}/`;
  const url = new URL(ticketUrl);
  if (url.username || url.password || !url.href.startsWith(base)) {
    throw new Error("GitLab ticket URL is outside the provider's base URL");
  }
  const match = url.pathname
    .slice(new URL(base).pathname.length)
    .match(/^(.+)\/-\/issues\/\d+\/?$/);
  if (!match) throw new Error("Invalid GitLab issue URL");
  const projectPath = decodeURIComponent(match[1]);
  if (!projectPath.startsWith(`${c.groupPath}/`))
    throw new Error("GitLab ticket is outside the provider's group");
  return { ...config, projectPath };
}

interface GitLabNote {
  id: number;
  body?: string | null;
  created_at: string;
  system?: boolean;
  author?: { id: number; username: string; name?: string | null } | null;
}

interface GitLabIssue {
  state: string;
  labels: string[];
}

const stateName = (state: string) => (state === "closed" ? "Closed" : "Open");

async function projectLabels(config: TicketProviderConfig): Promise<string[]> {
  const names: string[] = [];
  const c = asConfig(config);
  const target = c.projectPath
    ? `projects/${encodeURIComponent(c.projectPath)}`
    : `groups/${encodeURIComponent(c.groupPath!)}`;
  for (let page = 1; page <= 5; page++) {
    const res = await call<Array<{ name: string }>>(
      config,
      `/${target}/labels?per_page=100&page=${page}`,
    );
    names.push(...(res.body ?? []).map((l) => l.name));
    const total = Number(res.headers.get("x-total-pages") ?? "1");
    if (!Number.isFinite(total) || page >= total) break;
  }
  return names;
}

async function getIssue(ticketId: string, config: TicketProviderConfig) {
  return (await call<GitLabIssue>(config, issuePath(config, ticketId))).body;
}

export const gitlabRoundTrip: TicketRoundTrip = {
  source: "gitlab",
  capabilities: { links: true, statuses: true },

  normalizeTicketId: (input) => {
    const s = input.trim();
    const m = s.match(/^#?(\d+)$/) ?? s.match(/\/-\/issues\/(\d+)(?:[/?#]|$)/);
    return m ? m[1] : null;
  },

  async whoAmI(config) {
    const me = (
      await call<{ id: number; username: string; name?: string | null; email?: string | null }>(
        config,
        "/user",
      )
    ).body;
    return {
      accountId: String(me.id),
      name: me.username,
      displayName: me.name || me.username,
      emailAddress: me.email ?? null,
    };
  },

  async listComments(ticketId, config, max = 50) {
    const per = Math.min(Math.max(max, 1), 100);
    const notes =
      (
        await call<GitLabNote[]>(
          config,
          `${issuePath(config, ticketId)}/notes?sort=desc&order_by=created_at&per_page=${per}`,
        )
      ).body ?? [];
    return notes
      .filter((n) => !n.system)
      .reverse()
      .map((n): TicketCommentRecord => ({
        id: String(n.id),
        author: {
          accountId: n.author ? String(n.author.id) : null,
          name: n.author?.username ?? null,
          displayName: n.author?.name || n.author?.username || null,
        },
        body: n.body ?? "",
        created: n.created_at,
      }));
  },

  async postComment(ticketId, parts, config) {
    const res = await call<{ id: number }>(config, `${issuePath(config, ticketId)}/notes`, {
      method: "POST",
      body: { body: markdownCommentBody(parts) },
    });
    return { id: res.body?.id != null ? String(res.body.id) : null };
  },

  async upsertLink(ticketId, link, config) {
    const body = linkCommentBody(link);
    if (link.previousId) {
      try {
        await call(config, `${issuePath(config, ticketId)}/notes/${link.previousId}`, {
          method: "PUT",
          body: { body },
        });
        return { id: link.previousId };
      } catch (err) {
        if (!isNotFound(err)) throw err; // someone deleted it: a new one takes its place
      }
    }
    const res = await call<{ id: number }>(config, `${issuePath(config, ticketId)}/notes`, {
      method: "POST",
      body: { body },
    });
    return { id: res.body?.id != null ? String(res.body.id) : null };
  },

  async statuses(config) {
    const labels = await projectLabels(config);
    return {
      statuses: [
        ...STATES.map((name) => ({ name, category: "State" })),
        ...labels.map((name) => ({ name, category: "Label" })),
      ],
      scope: asConfig(config).projectPath ? "project" : "group",
    };
  },

  async issueStatus(ticketId, config) {
    const [issue, labels] = await Promise.all([getIssue(ticketId, config), projectLabels(config)]);
    const current = [stateName(issue.state), ...(issue.labels ?? [])];
    const available = [...STATES, ...labels].filter((n) => !current.some((c) => sameName(c, n)));
    return { status: stateName(issue.state), current, available };
  },

  async moveToStatus(ticketId, status, config, opts = {}) {
    const issue = await getIssue(ticketId, config);
    const from = stateName(issue.state);
    const onIssue = issue.labels ?? [];
    const off = onIssue.filter(
      (l) =>
        !sameName(l, status) &&
        (opts.others ?? []).some((o) => sameName(o, l) && !STATES.some((s) => sameName(s, o))),
    );
    const update: Record<string, string> = {};
    if (off.length) update.remove_labels = off.join(",");
    const state = STATES.find((s) => sameName(s, status));
    let there: boolean;
    if (state) {
      there = sameName(from, state);
      if (!there) update.state_event = state === "Closed" ? "close" : "reopen";
    } else {
      const labels = await projectLabels(config);
      const label = labels.find((l) => sameName(l, status));
      if (!label) {
        return { moved: false, from, reason: "unreachable", available: [...STATES, ...labels] };
      }
      there = onIssue.some((l) => sameName(l, label));
      if (!there) update.add_labels = label;
    }
    if (!Object.keys(update).length) return { moved: false, from, reason: "already" };
    await call(config, issuePath(config, ticketId), { method: "PUT", body: update });
    return { moved: true, from };
  },

  mentionsAccount: (body, account) => atMentions(body, account?.name),

  /**
   * GET /projects/:id/members/all/:user_id (inherited members too): a
   * Developer or above may push to the project, so their comment may steer
   * the work; anyone else (a Reporter, a Guest, someone who may only comment
   * on a public project) may not.
   */
  async mayInstruct(_ticketId, author, config) {
    if (!author.accountId || !/^\d+$/.test(author.accountId)) return false;
    const project = asConfig(config).projectPath;
    if (!project) return false;
    try {
      const res = await call<{ access_level?: number; state?: string }>(
        config,
        `/projects/${encodeURIComponent(project)}/members/all/${author.accountId}`,
      );
      return (res.body?.access_level ?? 0) >= DEVELOPER_ACCESS && res.body?.state !== "blocked";
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  },
};
