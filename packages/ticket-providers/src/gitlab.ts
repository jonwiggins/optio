import {
  TicketSource,
  DEFAULT_TICKET_LABEL,
  DEFAULT_MAX_TICKET_PAGES,
  type Ticket,
  type TicketComment,
  type TicketConnectionTest,
  type TicketProviderConfig,
} from "@optio/shared";
import { gitLabFetch, gitLabInstanceForHost, gitLabInstanceForUrl } from "@optio/shared";
import { assertSsrfSafe } from "@optio/shared/ssrf";
import type { TicketProvider } from "./types.js";

export interface GitLabProviderConfig extends TicketProviderConfig {
  token: string;
  /** GitLab project path, e.g. "group/project" or "group/subgroup/project" */
  projectPath?: string;
  /**
   * A group path instead of a project ("group" or "group/subgroup"): the
   * issues of every project in it. Each ticket's `repo` is its own project.
   */
  groupPath?: string;
  /**
   * GitLab host, defaults to "gitlab.com". It may carry a port and a path
   * prefix (`gitlab.corp:8443`, `example.com/gitlab`).
   */
  host?: string;
  label?: string;
  maxPages?: number;
}

function asGitLabConfig(config: TicketProviderConfig): GitLabProviderConfig {
  const c = config as GitLabProviderConfig;
  if (!c.token || !(c.projectPath || c.groupPath)) {
    throw new Error("GitLab provider requires a token and a projectPath or groupPath in config");
  }
  return c;
}

/** The host as `host[:port][/prefix]`, whatever scheme or trailing slash it was given with. */
function gitLabHost(config: GitLabProviderConfig): string {
  return (
    (config.host ?? "gitlab.com")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "") || "gitlab.com"
  );
}

/** The project a group's issue lives in: its full reference, else its web URL. */
function issueProjectPath(issue: any, host: string): string | undefined {
  const ref = typeof issue.references?.full === "string" ? issue.references.full : "";
  const fromRef = ref.replace(/#\d+$/, "");
  if (fromRef && fromRef !== ref) return fromRef;
  const web = typeof issue.web_url === "string" ? issue.web_url : "";
  const m = web.match(/^https?:\/\/(.+?)\/-\/issues\/\d+/);
  if (!m) return undefined;
  const path = m[1].startsWith(`${host}/`)
    ? m[1].slice(host.length + 1)
    : m[1].replace(/^[^/]+\//, "");
  return path || undefined;
}

export class GitLabTicketProvider implements TicketProvider {
  readonly source = TicketSource.GITLAB;

  private apiUrl(config: GitLabProviderConfig): string {
    return `https://${gitLabHost(config)}/api/v4`;
  }

  /** The project a ticket's comments and state go to (a group's sync names it per ticket). */
  private projectId(config: GitLabProviderConfig): string {
    if (!config.projectPath) {
      throw new Error("GitLab provider needs the ticket's projectPath for this call");
    }
    return encodeURIComponent(config.projectPath);
  }

  private headers(config: GitLabProviderConfig): Record<string, string> {
    // Bearer: every GitLab token kind, OAuth included (PRIVATE-TOKEN takes no OAuth token).
    return { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  }

  async fetchActionableTickets(config: TicketProviderConfig): Promise<Ticket[]> {
    const glConfig = asGitLabConfig(config);
    const label = glConfig.label ?? DEFAULT_TICKET_LABEL;
    const maxPages = glConfig.maxPages ?? DEFAULT_MAX_TICKET_PAGES;
    const baseUrl = this.apiUrl(glConfig);
    const hdrs = this.headers(glConfig);
    const host = gitLabHost(glConfig);
    // One project's issues, or every project's in a group.
    const listPath = glConfig.projectPath
      ? `projects/${encodeURIComponent(glConfig.projectPath)}`
      : `groups/${encodeURIComponent(glConfig.groupPath!)}`;

    const allTickets: Ticket[] = [];
    let page = 1;

    // SSRF check: verify the constructed API URL does not target internal addresses
    await assertSsrfSafe(baseUrl);

    while (page <= maxPages) {
      const params = new URLSearchParams({
        labels: label,
        state: "opened",
        per_page: "100",
        page: String(page),
      });

      const fetchUrl = `${baseUrl}/${listPath}/issues?${params}`;
      const res = await gitLabFetch(fetchUrl, { headers: hdrs, redirect: "error" });
      if (!res.ok) break;

      const issues = (await res.json()) as any[];
      if (issues.length === 0) break;

      for (const issue of issues) {
        const projectPath = glConfig.projectPath ?? issueProjectPath(issue, host);
        allTickets.push({
          externalId: String(issue.iid),
          source: TicketSource.GITLAB,
          title: issue.title ?? "",
          body: issue.description ?? "",
          url: issue.web_url ?? `https://${host}/${projectPath}/-/issues/${issue.iid}`,
          labels: issue.labels ?? [],
          assignee: issue.assignee?.username,
          repo: projectPath,
          metadata: {
            number: issue.iid,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
          },
        });
      }

      // Check for next page
      const totalPages = parseInt(res.headers.get("x-total-pages") ?? "1", 10);
      if (page >= totalPages) break;
      page++;
    }

    return allTickets;
  }

  /** Read the project (or group) with the token: what it is, or why not. */
  async testConnection(config: TicketProviderConfig): Promise<TicketConnectionTest> {
    let glConfig: GitLabProviderConfig;
    try {
      glConfig = asGitLabConfig(config);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const target = glConfig.projectPath
      ? `projects/${encodeURIComponent(glConfig.projectPath)}`
      : `groups/${encodeURIComponent(glConfig.groupPath!)}`;
    const what = glConfig.projectPath ? "project" : "group";
    const url = `${this.apiUrl(glConfig)}/${target}`;
    try {
      await assertSsrfSafe(url);
      const res = await gitLabFetch(url, { headers: this.headers(glConfig), redirect: "error" });
      if (res.status === 401) return { ok: false, error: "GitLab refused the token (401)" };
      if (res.status === 403 || res.status === 404) {
        return { ok: false, error: `The token can't see that ${what} (${res.status})` };
      }
      if (!res.ok) return { ok: false, error: `GitLab answered ${res.status}` };
      const body = (await res.json()) as { path_with_namespace?: string; full_path?: string };
      return {
        ok: true,
        serverTitle: body.path_with_namespace ?? body.full_path ?? glConfig.projectPath,
        deploymentType: gitLabHost(glConfig) === "gitlab.com" ? "Cloud" : "Self-managed",
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async fetchTicketComments(
    ticketId: string,
    config: TicketProviderConfig,
  ): Promise<TicketComment[]> {
    const glConfig = asGitLabConfig(config);
    const baseUrl = this.apiUrl(glConfig);
    const pid = this.projectId(glConfig);
    const hdrs = this.headers(glConfig);

    const fetchUrl = `${baseUrl}/projects/${pid}/issues/${ticketId}/notes?sort=asc&per_page=30`;
    await assertSsrfSafe(fetchUrl);
    const res = await gitLabFetch(fetchUrl, { headers: hdrs, redirect: "error" });
    if (!res.ok) return [];

    const notes = (await res.json()) as any[];
    return notes
      .filter((n: any) => !n.system)
      .map((n: any) => ({
        author: n.author?.username ?? "unknown",
        body: n.body ?? "",
        createdAt: n.created_at ?? "",
      }));
  }

  async addComment(ticketId: string, comment: string, config: TicketProviderConfig): Promise<void> {
    const glConfig = asGitLabConfig(config);
    const baseUrl = this.apiUrl(glConfig);
    const pid = this.projectId(glConfig);
    const hdrs = this.headers(glConfig);

    const fetchUrl = `${baseUrl}/projects/${pid}/issues/${ticketId}/notes`;
    await assertSsrfSafe(fetchUrl);
    await gitLabFetch(fetchUrl, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify({ body: comment }),
      redirect: "error",
    });
  }

  async updateState(
    ticketId: string,
    state: "open" | "closed",
    config: TicketProviderConfig,
  ): Promise<void> {
    const glConfig = asGitLabConfig(config);
    const baseUrl = this.apiUrl(glConfig);
    const pid = this.projectId(glConfig);
    const hdrs = this.headers(glConfig);

    const stateEvent = state === "closed" ? "close" : "reopen";
    const fetchUrl = `${baseUrl}/projects/${pid}/issues/${ticketId}`;
    await assertSsrfSafe(fetchUrl);
    await gitLabFetch(fetchUrl, {
      method: "PUT",
      headers: hdrs,
      body: JSON.stringify({ state_event: stateEvent }),
      redirect: "error",
    });
  }
}
